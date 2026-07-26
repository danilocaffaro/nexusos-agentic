import { sha256Bytes, sha256Hex } from "../governance/crypto";

export const RUNNER_TOKEN_BYTES = 32;
export const RUNNER_PUBLIC_KEY_BYTES = 32;
export const RUNNER_SIGNATURE_BYTES = 64;
export const RUNNER_NONCE_BYTES = 16;
export const RUNNER_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const RUNNER_SKEW_PAST_MS = 60_000;
export const RUNNER_SKEW_FUTURE_MS = 30_000;
export const RUNNER_HEARTBEAT_BODY = new TextEncoder().encode("{}");

const SMALL_ORDER_PUBLIC_KEYS = new Set([
  "0100000000000000000000000000000000000000000000000000000000000000",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
]);

export type RunnerSignatureDomain =
  | "nexus-runner-enroll-v1"
  | "nexus-runner-heartbeat-v1"
  | "nexus-runner-lease-claim-v1"
  | "nexus-runner-lease-renew-v1"
  | "nexus-runner-run-complete-v1";

export type RunnerSignatureInput = {
  domain: RunnerSignatureDomain;
  keyId?: string;
  method: "POST";
  pathname: string;
  audience: string;
  timestamp: string;
  nonce: string;
  body: Uint8Array;
};

export type VerifiedRunnerSignature = {
  publicKey: string;
  nonce: string;
  timestamp: string;
  requestHash: string;
  stringToSign: string;
};

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeCanonicalBase64Url(
  value: string,
  expectedBytes: number,
): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (
      bytes.byteLength !== expectedBytes ||
      encodeBase64Url(bytes) !== value
    ) {
      return undefined;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

export function generateRunnerToken(): string {
  return encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(RUNNER_TOKEN_BYTES)),
  );
}

export function configuredRunnerAudience(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (
      value !== url.origin ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLoopback))
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export async function hashRunnerToken(token: string): Promise<string | undefined> {
  const bytes = decodeCanonicalBase64Url(token, RUNNER_TOKEN_BYTES);
  return bytes ? (await sha256Bytes(bytes)).hex : undefined;
}

export async function publicKeyFingerprint(
  publicKey: string,
): Promise<string | undefined> {
  const bytes = decodeCanonicalBase64Url(
    publicKey,
    RUNNER_PUBLIC_KEY_BYTES,
  );
  return bytes
    ? `SHA256:${encodeBase64Url(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
        ),
      )}`
    : undefined;
}

export async function deriveRunnerIdentity(
  tokenHash: string,
  publicKey: string,
): Promise<{ principalId: string; runnerId: string }> {
  const suffix = async (domain: string) =>
    (await sha256Hex(`${domain}\n${tokenHash}\n${publicKey}`)).slice(0, 32);
  return {
    principalId: `prn_${await suffix("nexus.principal.id.v1")}`,
    runnerId: `rnr_${await suffix("nexus.runner.id.v1")}`,
  };
}

export async function buildRunnerStringToSign(
  input: RunnerSignatureInput,
): Promise<{ value: string; hash: string }> {
  const bodyHash = (await sha256Bytes(input.body)).hex;
  const value = [
    input.domain,
    ...(input.keyId ? [input.keyId] : []),
    input.method,
    input.pathname,
    input.audience,
    input.timestamp,
    input.nonce,
    `sha256:${bodyHash}`,
  ].join("\n");
  return {
    value,
    hash: await sha256Hex(value),
  };
}

export function hasValidRunnerTimestamp(
  timestamp: string,
  nowMs: number,
): boolean {
  if (!RUNNER_TIMESTAMP_PATTERN.test(timestamp)) return false;
  const parsed = Date.parse(timestamp);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === timestamp &&
    parsed >= nowMs - RUNNER_SKEW_PAST_MS &&
    parsed <= nowMs + RUNNER_SKEW_FUTURE_MS
  );
}

export function isHeartbeatBody(body: Uint8Array): boolean {
  return (
    body.byteLength === RUNNER_HEARTBEAT_BODY.byteLength &&
    body.every((byte, index) => byte === RUNNER_HEARTBEAT_BODY[index])
  );
}

export async function verifyRunnerSignature(input: {
  signatureInput: Omit<RunnerSignatureInput, "nonce" | "timestamp">;
  publicKey: string;
  signature: string;
  nonce: string;
  timestamp: string;
  nowMs: number;
}): Promise<VerifiedRunnerSignature | undefined> {
  const publicKeyBytes = decodeCanonicalBase64Url(
    input.publicKey,
    RUNNER_PUBLIC_KEY_BYTES,
  );
  const signatureBytes = decodeCanonicalBase64Url(
    input.signature,
    RUNNER_SIGNATURE_BYTES,
  );
  const nonceBytes = decodeCanonicalBase64Url(
    input.nonce,
    RUNNER_NONCE_BYTES,
  );
  if (
    !publicKeyBytes ||
    !signatureBytes ||
    !nonceBytes ||
    !hasValidRunnerTimestamp(input.timestamp, input.nowMs) ||
    SMALL_ORDER_PUBLIC_KEYS.has(toHex(publicKeyBytes))
  ) {
    return undefined;
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes.slice().buffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const signed = await buildRunnerStringToSign({
      ...input.signatureInput,
      nonce: input.nonce,
      timestamp: input.timestamp,
    });
    const verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes.slice().buffer,
      new TextEncoder().encode(signed.value),
    );
    return verified
      ? {
          publicKey: input.publicKey,
          nonce: input.nonce,
          timestamp: input.timestamp,
          requestHash: signed.hash,
          stringToSign: signed.value,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
