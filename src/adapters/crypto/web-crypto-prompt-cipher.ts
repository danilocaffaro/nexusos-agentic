import {
  ENGINE_PROMPT_MAX_BYTES,
  ENGINE_PROMPT_MIN_BYTES,
} from "../../contracts/execution-engines";
import {
  ENGINE_PROMPT_REF_PATTERN,
} from "../../domain/runners/execution-engine";
import { canonicalJson } from "../../domain/governance/canonical-json";
import { RUN_ID_PATTERN } from "../../domain/runners/lease-protocol";
import type {
  PromptCipher,
  PromptCipherContext,
  PromptCipherEnvelope,
} from "../../ports/prompt-cipher";
import {
  PROMPT_CIPHER_IV_BYTES,
  PROMPT_CIPHER_TAG_BYTES,
  PROMPT_CIPHER_VERSION,
} from "../../ports/prompt-cipher";

const KEYRING_SCHEMA_VERSION = 1;
const KEYRING_MAX_BYTES = 2_048;
const KEYRING_MAX_KEYS = 3;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;
const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOCAL_KEY_ID = "local-development-v1";

export const PROMPT_CIPHER_KEYRING_BINDING =
  "NEXUS_PROMPT_CIPHER_KEYS";

export type PromptCipherKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
  schemaVersion: typeof KEYRING_SCHEMA_VERSION;
};

export class PromptCipherError extends Error {
  readonly code = "prompt_cipher_key_unavailable";
  readonly status = 503;

  constructor() {
    super("Prompt cipher is unavailable.");
    this.name = "PromptCipherError";
  }
}

export class PromptCipherContextError extends Error {
  constructor() {
    super("Invalid prompt cipher context.");
    this.name = "PromptCipherContextError";
  }
}

export function resolvePromptCipherKeyring(input: {
  allowLocalIdentity: boolean;
  serialized: string | undefined;
}): PromptCipherKeyring {
  if (input.serialized !== undefined) {
    return parsePromptCipherKeyring(input.serialized);
  }
  if (!input.allowLocalIdentity) throw new PromptCipherError();
  return {
    activeKeyId: LOCAL_KEY_ID,
    keys: new Map([
      [
        LOCAL_KEY_ID,
        Uint8Array.from({ length: 32 }, (_, index) => index),
      ],
    ]),
    schemaVersion: KEYRING_SCHEMA_VERSION,
  };
}

export function parsePromptCipherKeyring(
  serialized: string,
): PromptCipherKeyring {
  if (
    serialized.length < 2 ||
    new TextEncoder().encode(serialized).byteLength > KEYRING_MAX_BYTES
  ) {
    throw new PromptCipherError();
  }
  let parsed: unknown;
  let canonical: string;
  try {
    parsed = JSON.parse(serialized);
    canonical = canonicalJson(parsed);
  } catch {
    throw new PromptCipherError();
  }
  const value = plainRecord(parsed);
  const keys = plainRecord(value?.keys);
  if (
    !value ||
    !keys ||
    canonical !== serialized ||
    !hasExactKeys(value, ["activeKeyId", "keys", "schemaVersion"]) ||
    value.schemaVersion !== KEYRING_SCHEMA_VERSION ||
    typeof value.activeKeyId !== "string" ||
    !KEY_ID_PATTERN.test(value.activeKeyId) ||
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > KEYRING_MAX_KEYS ||
    !Object.hasOwn(keys, value.activeKeyId)
  ) {
    throw new PromptCipherError();
  }
  const decoded = new Map<string, Uint8Array>();
  for (const [keyId, key] of Object.entries(keys)) {
    if (
      !KEY_ID_PATTERN.test(keyId) ||
      typeof key !== "string"
    ) {
      throw new PromptCipherError();
    }
    decoded.set(keyId, decodeCanonicalKey(key));
  }
  return {
    activeKeyId: value.activeKeyId,
    keys: decoded,
    schemaVersion: KEYRING_SCHEMA_VERSION,
  };
}

export function assertPromptCipherKeysCoverLiveReferences(
  keyring: PromptCipherKeyring,
  liveKeyIds: Iterable<string>,
): void {
  for (const keyId of liveKeyIds) {
    if (!keyring.keys.has(keyId)) throw new PromptCipherError();
  }
}

export function promptCipherAdditionalData(
  context: PromptCipherContext,
): Uint8Array {
  assertPromptCipherContext(context);
  return new TextEncoder().encode(
    `${context.runId}|${context.organizationId}|${context.promptRef}`,
  );
}

export class WebCryptoPromptCipher implements PromptCipher {
  readonly #keyring: PromptCipherKeyring;

  constructor(keyring: PromptCipherKeyring) {
    this.#keyring = cloneKeyring(keyring);
  }

  async encrypt(
    plaintext: Uint8Array,
    context: PromptCipherContext,
  ): Promise<PromptCipherEnvelope> {
    if (
      !(plaintext instanceof Uint8Array) ||
      plaintext.byteLength < ENGINE_PROMPT_MIN_BYTES ||
      plaintext.byteLength > ENGINE_PROMPT_MAX_BYTES
    ) {
      throw new PromptCipherError();
    }
    const keyBytes = this.#keyring.keys.get(this.#keyring.activeKeyId);
    if (!keyBytes) throw new PromptCipherError();
    const iv = crypto.getRandomValues(
      new Uint8Array(PROMPT_CIPHER_IV_BYTES),
    );
    const encrypted = await encryptAesGcm(
      keyBytes,
      plaintext,
      iv,
      promptCipherAdditionalData(context),
    );
    const tagOffset = encrypted.byteLength - PROMPT_CIPHER_TAG_BYTES;
    if (tagOffset !== plaintext.byteLength) throw new PromptCipherError();
    return {
      cipherVersion: PROMPT_CIPHER_VERSION,
      ciphertext: encrypted.slice(0, tagOffset),
      iv: iv.slice(),
      keyId: this.#keyring.activeKeyId,
      tag: encrypted.slice(tagOffset),
    };
  }

  async decrypt(
    envelope: PromptCipherEnvelope,
    context: PromptCipherContext,
  ): Promise<Uint8Array> {
    if (
      envelope.cipherVersion !== PROMPT_CIPHER_VERSION ||
      !KEY_ID_PATTERN.test(envelope.keyId) ||
      !(envelope.iv instanceof Uint8Array) ||
      envelope.iv.byteLength !== PROMPT_CIPHER_IV_BYTES ||
      !(envelope.ciphertext instanceof Uint8Array) ||
      envelope.ciphertext.byteLength < ENGINE_PROMPT_MIN_BYTES ||
      envelope.ciphertext.byteLength > ENGINE_PROMPT_MAX_BYTES ||
      !(envelope.tag instanceof Uint8Array) ||
      envelope.tag.byteLength !== PROMPT_CIPHER_TAG_BYTES
    ) {
      throw new PromptCipherError();
    }
    const keyBytes = this.#keyring.keys.get(envelope.keyId);
    if (!keyBytes) throw new PromptCipherError();
    const combined = new Uint8Array(
      envelope.ciphertext.byteLength + envelope.tag.byteLength,
    );
    combined.set(envelope.ciphertext);
    combined.set(envelope.tag, envelope.ciphertext.byteLength);
    let plaintext: Uint8Array;
    try {
      const key = await importAesKey(keyBytes, ["decrypt"]);
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            additionalData: bufferSource(
              promptCipherAdditionalData(context),
            ),
            iv: bufferSource(envelope.iv),
            name: "AES-GCM",
            tagLength: 128,
          },
          key,
          bufferSource(combined),
        ),
      );
    } catch {
      throw new PromptCipherError();
    }
    if (
      plaintext.byteLength < ENGINE_PROMPT_MIN_BYTES ||
      plaintext.byteLength > ENGINE_PROMPT_MAX_BYTES
    ) {
      throw new PromptCipherError();
    }
    return plaintext;
  }
}

async function encryptAesGcm(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  try {
    const key = await importAesKey(keyBytes, ["encrypt"]);
    return new Uint8Array(
      await crypto.subtle.encrypt(
        {
          additionalData: bufferSource(additionalData),
          iv: bufferSource(iv),
          name: "AES-GCM",
          tagLength: 128,
        },
        key,
        bufferSource(plaintext),
      ),
    );
  } catch {
    throw new PromptCipherError();
  }
}

async function importAesKey(
  keyBytes: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bufferSource(keyBytes),
    { length: 256, name: "AES-GCM" },
    false,
    usages,
  );
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function assertPromptCipherContext(context: PromptCipherContext): void {
  if (
    !context ||
    !RUN_ID_PATTERN.test(context.runId) ||
    !ENGINE_PROMPT_REF_PATTERN.test(context.promptRef) ||
    !ORGANIZATION_ID_PATTERN.test(context.organizationId) ||
    context.organizationId.includes("|")
  ) {
    throw new PromptCipherContextError();
  }
}

function decodeCanonicalKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new PromptCipherError();
  }
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + "=",
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== value) {
      throw new PromptCipherError();
    }
    return bytes;
  } catch {
    throw new PromptCipherError();
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function cloneKeyring(keyring: PromptCipherKeyring): PromptCipherKeyring {
  if (
    keyring.schemaVersion !== KEYRING_SCHEMA_VERSION ||
    !KEY_ID_PATTERN.test(keyring.activeKeyId) ||
    keyring.keys.size < 1 ||
    keyring.keys.size > KEYRING_MAX_KEYS ||
    !keyring.keys.has(keyring.activeKeyId)
  ) {
    throw new PromptCipherError();
  }
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, value] of keyring.keys) {
    if (
      !KEY_ID_PATTERN.test(keyId) ||
      !(value instanceof Uint8Array) ||
      value.byteLength !== 32
    ) {
      throw new PromptCipherError();
    }
    keys.set(keyId, value.slice());
  }
  return {
    activeKeyId: keyring.activeKeyId,
    keys,
    schemaVersion: KEYRING_SCHEMA_VERSION,
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function plainRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
