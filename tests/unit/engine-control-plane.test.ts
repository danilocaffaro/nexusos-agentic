import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertPromptCipherKeysCoverLiveReferences,
  parsePromptCipherKeyring,
  PROMPT_CIPHER_KEYRING_BINDING,
  promptCipherAdditionalData,
  PromptCipherContextError,
  PromptCipherError,
  resolvePromptCipherKeyring,
  WebCryptoPromptCipher,
} from "../../src/adapters/crypto/web-crypto-prompt-cipher";
import {
  ENGINE_CREATE_REQUEST_MAX_BYTES,
  ENGINE_PROMPT_MAX_BYTES,
  ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES,
} from "../../src/contracts/execution-engines";
import { canonicalJson } from "../../src/domain/governance/canonical-json";
import {
  buildEngineLeaseClaimDescriptor,
  buildEnginePromptReadSentinel,
  canonicalEngineLeaseClaimBody,
  canonicalEngineLeaseClaimDescriptor,
  canonicalEnginePromptReadBody,
  encodeExactPrompt,
  EngineControlPlaneInputError,
  generatePromptRef,
  parseEngineLeaseClaimBody,
  parseEnginePromptReadBody,
  parseEngineRunCreateRequest,
  readBoundedEngineRunRequest,
} from "../../src/domain/runners/engine-control-plane";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const fixture = (name: string) =>
  readFile(new URL(`../fixtures/s6-b4/${name}`, import.meta.url), "utf8");

const context = {
  organizationId: "org-local-aurora",
  promptRef: `prm_${"3".repeat(32)}`,
  runId: `run_${"1".repeat(32)}`,
};

test("engine create parser preserves exact UTF-8 and validates boundaries", async () => {
  const prompt = "ação\n🧭";
  const request = {
    assignedRunnerId: `rnr_${"a".repeat(32)}`,
    engine: "claude_code_cli",
    prompt,
  };
  const parsed = await parseEngineRunCreateRequest(
    encode(JSON.stringify(request)),
  );
  assert.equal("prompt" in parsed, false);
  assert.deepEqual(parsed.promptBytes, encode(prompt));
  assert.equal(
    parsed.promptSha256,
    createHash("sha256").update(encode(prompt)).digest("hex"),
  );

  const one = await parseEngineRunCreateRequest(
    encode(JSON.stringify({ ...request, prompt: "a" })),
  );
  const maximum = await parseEngineRunCreateRequest(
    encode(
      JSON.stringify({
        ...request,
        prompt: "a".repeat(ENGINE_PROMPT_MAX_BYTES),
      }),
    ),
  );
  assert.equal(one.promptBytes.byteLength, 1);
  assert.equal(maximum.promptBytes.byteLength, ENGINE_PROMPT_MAX_BYTES);

  for (const invalid of [
    { ...request, prompt: "" },
    { ...request, prompt: "a".repeat(ENGINE_PROMPT_MAX_BYTES + 1) },
    { ...request, engine: "open_code" },
    { ...request, assignedRunnerId: "rnr_wrong" },
    { ...request, unknown: true },
  ]) {
    await assert.rejects(
      parseEngineRunCreateRequest(encode(JSON.stringify(invalid))),
      inputError("invalid_engine_run_request", 400),
    );
  }
});

test("prompt validation rejects unmatched surrogates without normalization", async () => {
  const base = {
    assignedRunnerId: `rnr_${"a".repeat(32)}`,
    engine: "codex_cli",
  };
  for (const prompt of ["\ud800", "\udfff", "a\ud800b", "\udc00\ud800"]) {
    await assert.rejects(
      parseEngineRunCreateRequest(
        encode(JSON.stringify({ ...base, prompt })),
      ),
      inputError("invalid_engine_run_request", 400),
    );
    assert.throws(
      () => encodeExactPrompt(prompt),
      inputError("invalid_engine_run_request", 400),
    );
  }
  const composed = await parseEngineRunCreateRequest(
    encode(JSON.stringify({ ...base, prompt: "\u00e9" })),
  );
  const decomposed = await parseEngineRunCreateRequest(
    encode(JSON.stringify({ ...base, prompt: "e\u0301" })),
  );
  assert.notDeepEqual(composed.promptBytes, decomposed.promptBytes);
  assert.deepEqual(composed.promptBytes, encode("\u00e9"));
  assert.deepEqual(decomposed.promptBytes, encode("e\u0301"));
});

test("prompt byte bounds are independent from UTF-16 code-unit length", async () => {
  const base = {
    assignedRunnerId: `rnr_${"a".repeat(32)}`,
    engine: "codex_cli",
  };
  const exact = "\u00e9".repeat(4_096);
  const parsed = await parseEngineRunCreateRequest(
    encode(JSON.stringify({ ...base, prompt: exact })),
  );
  assert.equal(exact.length, 4_096);
  assert.equal(parsed.promptBytes.byteLength, 8_192);
  const oversized = "\u00e9".repeat(4_097);
  assert.ok(oversized.length < ENGINE_PROMPT_MAX_BYTES);
  await assert.rejects(
    parseEngineRunCreateRequest(
      encode(JSON.stringify({ ...base, prompt: oversized })),
    ),
    inputError("invalid_engine_run_request", 400),
  );
});

test("create parser rejects BOM, malformed UTF-8 and non-record JSON", async () => {
  const valid = encode(
    JSON.stringify({
      assignedRunnerId: `rnr_${"a".repeat(32)}`,
      engine: "codex_cli",
      prompt: "safe",
    }),
  );
  const bom = new Uint8Array(valid.byteLength + 3);
  bom.set([0xef, 0xbb, 0xbf]);
  bom.set(valid, 3);
  for (const raw of [
    bom,
    new Uint8Array([0xc3, 0x28]),
    encodeRawJsonPrompt(new Uint8Array([0xed, 0xa0, 0x80])),
    encode("[]"),
    encode("null"),
    new Uint8Array(),
  ]) {
    await assert.rejects(
      parseEngineRunCreateRequest(raw),
      inputError("invalid_engine_run_request", 400),
    );
  }
});

test("worst valid prompt escaping fits under the locked 56 KiB bound", async () => {
  const raw = encode(
    JSON.stringify({
      assignedRunnerId: `rnr_${"a".repeat(32)}`,
      engine: "claude_code_cli",
      prompt: "\u0000".repeat(ENGINE_PROMPT_MAX_BYTES),
    }),
  );
  assert.equal(raw.byteLength, 49_250);
  assert.ok(raw.byteLength < ENGINE_CREATE_REQUEST_MAX_BYTES);
  const parsed = await parseEngineRunCreateRequest(raw);
  assert.equal(parsed.promptBytes.byteLength, ENGINE_PROMPT_MAX_BYTES);
});

test("bounded reader counts streamed bytes before parsing", async () => {
  const exact = new Uint8Array(ENGINE_CREATE_REQUEST_MAX_BYTES).fill(7);
  const read = await readBoundedEngineRunRequest(
    streamedRequest([
      exact.slice(0, 1),
      exact.slice(1, 40_000),
      exact.slice(40_000),
    ]),
  );
  assert.deepEqual(read, exact);

  await assert.rejects(
    readBoundedEngineRunRequest(
      streamedRequest([
        exact,
        new Uint8Array([8]),
      ]),
    ),
    inputError("engine_run_request_too_large", 413),
  );
  await assert.rejects(
    readBoundedEngineRunRequest(
      streamedRequest([encode("longer")], "2"),
    ),
    inputError("invalid_engine_run_request", 400),
  );
  await assert.rejects(
    readBoundedEngineRunRequest(
      streamedRequest([encode("short")], "6"),
    ),
    inputError("invalid_engine_run_request", 400),
  );
  await assert.rejects(
    readBoundedEngineRunRequest(
      streamedRequest([encode("short")], "not-a-number"),
    ),
    inputError("invalid_engine_run_request", 400),
  );
  await assert.rejects(
    readBoundedEngineRunRequest(
      streamedRequest([encode("short")], "10000000"),
    ),
    inputError("engine_run_request_too_large", 413),
  );
});

test("declared oversize rejects without consuming the body", async () => {
  let readers = 0;
  const request = {
    body: {
      getReader() {
        readers += 1;
        throw new Error("body consumed");
      },
    },
    headers: new Headers({
      "content-length": String(ENGINE_CREATE_REQUEST_MAX_BYTES + 1),
    }),
  } as unknown as Request;
  await assert.rejects(
    readBoundedEngineRunRequest(request),
    inputError("engine_run_request_too_large", 413),
  );
  assert.equal(readers, 0);
});

test("signed engine bodies and prompt sentinel are exact canonical goldens", async () => {
  const claimText = (await fixture("engine-claim-body-v1.json")).trim();
  const promptText = (await fixture("prompt-read-body-v1.json")).trim();
  const sentinelText = (
    await fixture("prompt-read-sentinel-v1.json")
  ).trim();
  assert.deepEqual(parseEngineLeaseClaimBody(encode(claimText)), {
    engine: "claude_code_cli",
    operationId: `op_${"2".repeat(32)}`,
  });
  assert.equal(
    canonicalEngineLeaseClaimBody({
      engine: "claude_code_cli",
      operationId: `op_${"2".repeat(32)}`,
    }),
    claimText,
  );
  assert.deepEqual(parseEnginePromptReadBody(encode(promptText)), {
    fence: 1,
    leaseId: `lse_${"5".repeat(32)}`,
    promptRef: `prm_${"3".repeat(32)}`,
  });
  assert.equal(
    canonicalEnginePromptReadBody({
      fence: 1,
      leaseId: `lse_${"5".repeat(32)}`,
      promptRef: `prm_${"3".repeat(32)}`,
    }),
    promptText,
  );
  assert.equal(
    canonicalJson(buildEnginePromptReadSentinel(context.promptRef)),
    sentinelText,
  );

  for (const invalid of [
    `{"operationId":"op_${"2".repeat(32)}","engine":"claude_code_cli"}`,
    claimText.replace("claude_code_cli", "open_code"),
    claimText.slice(0, -1) + ',"unknown":true}',
    "\ufeff" + claimText,
  ]) {
    assert.equal(parseEngineLeaseClaimBody(encode(invalid)), undefined);
  }
  assert.equal(
    parseEnginePromptReadBody(
      encode(promptText.replace('"fence":1', '"fence":0')),
    ),
    undefined,
  );
});

test("engine lease claim descriptor matches the accepted nested golden", async () => {
  const expected = (await fixture("engine-claim-response-v1.json")).trim();
  const descriptor = buildEngineLeaseClaimDescriptor({
    cancelRequested: false,
    deadlineAt: "2026-07-27T12:20:00.000Z",
    engine: "claude_code_cli",
    engineVersion: "2.1.219",
    expiresAt: "2026-07-27T12:01:00.000Z",
    fence: 1,
    leaseId: `lse_${"5".repeat(32)}`,
    promptBytes: 120,
    promptRef: `prm_${"3".repeat(32)}`,
    promptSha256: "4".repeat(64),
    runId: `run_${"1".repeat(32)}`,
    timeoutMs: 600_000,
  });
  assert.equal(canonicalEngineLeaseClaimDescriptor(descriptor), expected);
  assert.equal("prompt" in descriptor.job, false);
  assert.throws(
    () =>
      buildEngineLeaseClaimDescriptor({
        ...descriptor.job,
        cancelRequested: false,
        expiresAt: "2026-07-27T12:21:00.000Z",
        fence: 1,
        leaseId: `lse_${"5".repeat(32)}`,
        runId: `run_${"1".repeat(32)}`,
      }),
    /Invalid engine lease claim descriptor/u,
  );
  for (const timeoutMs of [270_000, 600_000]) {
    const boundary = buildEngineLeaseClaimDescriptor({
      ...descriptor.job,
      cancelRequested: false,
      expiresAt: descriptor.expiresAt,
      fence: descriptor.fence,
      leaseId: descriptor.leaseId,
      runId: descriptor.runId,
      timeoutMs,
    });
    assert.equal(boundary.job.timeoutMs, timeoutMs);
  }
  for (const timeoutMs of [269_999, 600_001]) {
    assert.throws(
      () =>
        buildEngineLeaseClaimDescriptor({
          ...descriptor.job,
          cancelRequested: false,
          expiresAt: descriptor.expiresAt,
          fence: descriptor.fence,
          leaseId: descriptor.leaseId,
          runId: descriptor.runId,
          timeoutMs,
        }),
      /Invalid engine job descriptor/u,
    );
  }
  assert.equal(ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES, 4_096);
});

test("prompt keyring grammar is bounded, closed and local fallback is explicit", async () => {
  const serialized = (await fixture("prompt-keyring-v1.json")).trim();
  const keyring = parsePromptCipherKeyring(serialized);
  assert.equal(PROMPT_CIPHER_KEYRING_BINDING, "NEXUS_PROMPT_CIPHER_KEYS");
  assert.equal(keyring.activeKeyId, "test-key-a");
  assert.equal(keyring.keys.size, 2);
  assert.deepEqual(
    resolvePromptCipherKeyring({
      allowLocalIdentity: false,
      serialized,
    }),
    keyring,
  );
  assert.throws(
    () =>
      resolvePromptCipherKeyring({
        allowLocalIdentity: false,
        serialized: undefined,
      }),
    cipherUnavailable,
  );
  const local = resolvePromptCipherKeyring({
    allowLocalIdentity: true,
    serialized: undefined,
  });
  assert.equal(local.activeKeyId, "local-development-v1");
  assert.equal(local.keys.size, 1);

  const rawKey = testKey(0);
  for (const invalid of [
    "",
    "{}",
    JSON.stringify({
      activeKeyId: "absent",
      keys: { present: rawKey },
      schemaVersion: 1,
    }),
    JSON.stringify({
      activeKeyId: "a",
      keys: { a: rawKey, b: rawKey, c: rawKey, d: rawKey },
      schemaVersion: 1,
    }),
    JSON.stringify({
      activeKeyId: "a",
      keys: { a: rawKey.slice(1) },
      schemaVersion: 1,
    }),
    JSON.stringify({
      activeKeyId: "bad|id",
      keys: { "bad|id": rawKey },
      schemaVersion: 1,
    }),
    JSON.stringify({
      activeKeyId: "a",
      keys: { a: rawKey },
      schemaVersion: 2,
    }),
    `{"schemaVersion":1,"keys":{"a":"${rawKey}"},"activeKeyId":"a"}`,
    `{"activeKeyId":"a","activeKeyId":"b","keys":{"a":"${rawKey}","b":"${rawKey}"},"schemaVersion":1}`,
    `{"activeKeyId":"a","keys":{"a":"${rawKey}"},"schemaVersion":1e999}`,
    `{"activeKeyId":"a","extra":1e999,"keys":{"a":"${rawKey}"},"schemaVersion":1}`,
  ]) {
    assert.throws(() => parsePromptCipherKeyring(invalid), cipherUnavailable);
    assert.throws(
      () =>
        resolvePromptCipherKeyring({
          allowLocalIdentity: true,
          serialized: invalid,
        }),
      cipherUnavailable,
    );
  }

  const three = canonicalJson({
    activeKeyId: "a",
    keys: {
      a: rawKey,
      b: testKey(17),
      c: testKey(34),
    },
    schemaVersion: 1,
  });
  assert.equal(parsePromptCipherKeyring(three).keys.size, 3);
});

test("AES-256-GCM uses random IV and the exact context-bound AAD", async () => {
  const keyring = parsePromptCipherKeyring(
    (await fixture("prompt-keyring-v1.json")).trim(),
  );
  const cipher = new WebCryptoPromptCipher(keyring);
  const plaintext = encode("confidential prompt \ud83e\udded");
  const first = await cipher.encrypt(plaintext, context);
  const second = await cipher.encrypt(plaintext, context);
  assert.equal(first.keyId, "test-key-a");
  assert.equal(first.iv.byteLength, 12);
  assert.equal(first.tag.byteLength, 16);
  assert.notDeepEqual(first.iv, second.iv);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(await cipher.decrypt(first, context), plaintext);
  assert.deepEqual(await cipher.decrypt(second, context), plaintext);
  assert.equal(
    decode(promptCipherAdditionalData(context)),
    (await fixture("prompt-aad-v1.txt")).trim(),
  );
  assert.throws(
    () =>
      promptCipherAdditionalData({
        ...context,
        organizationId: "org|ambiguous",
      }),
    (error: unknown) =>
      error instanceof PromptCipherContextError &&
      error.message === "Invalid prompt cipher context.",
  );
  assert.throws(
    () =>
      promptCipherAdditionalData({
        ...context,
        runId: `run_${"x".repeat(32)}`,
      }),
    (error: unknown) => error instanceof PromptCipherContextError,
  );
});

test("wrong key id, AAD, tag, IV and corrupt ciphertext fail closed", async () => {
  const keyring = parsePromptCipherKeyring(
    (await fixture("prompt-keyring-v1.json")).trim(),
  );
  const cipher = new WebCryptoPromptCipher(keyring);
  const envelope = await cipher.encrypt(encode("sensitive"), context);
  const mutations = [
    { ...envelope, keyId: "unknown" },
    { ...envelope, iv: envelope.iv.slice(1) },
    { ...envelope, tag: flipFirst(envelope.tag) },
    { ...envelope, ciphertext: flipFirst(envelope.ciphertext) },
  ];
  for (const mutation of mutations) {
    await assert.rejects(
      cipher.decrypt(mutation, context),
      cipherUnavailable,
    );
  }
  for (const wrongContext of [
    { ...context, runId: `run_${"9".repeat(32)}` },
    { ...context, organizationId: "org-other" },
    { ...context, promptRef: `prm_${"9".repeat(32)}` },
  ]) {
    await assert.rejects(
      cipher.decrypt(envelope, wrongContext),
      cipherUnavailable,
    );
  }
});

test("rotation reads old rows, uses active key for new rows and blocks unsafe removal", async () => {
  const serialized = (await fixture("prompt-keyring-v1.json")).trim();
  const firstRing = parsePromptCipherKeyring(serialized);
  const firstCipher = new WebCryptoPromptCipher(firstRing);
  const oldEnvelope = await firstCipher.encrypt(encode("old row"), context);
  assert.equal(oldEnvelope.keyId, "test-key-a");

  const rotatedRing = parsePromptCipherKeyring(
    serialized.replace(
      '"activeKeyId":"test-key-a"',
      '"activeKeyId":"test-key-b"',
    ),
  );
  const rotatedCipher = new WebCryptoPromptCipher(rotatedRing);
  assert.deepEqual(
    await rotatedCipher.decrypt(oldEnvelope, context),
    encode("old row"),
  );
  const newEnvelope = await rotatedCipher.encrypt(encode("new row"), context);
  assert.equal(newEnvelope.keyId, "test-key-b");
  assertPromptCipherKeysCoverLiveReferences(rotatedRing, [
    "test-key-a",
    "test-key-b",
  ]);

  const removed = parsePromptCipherKeyring(
    JSON.stringify({
      activeKeyId: "test-key-b",
      keys: {
        "test-key-b":
          testKey(17),
      },
      schemaVersion: 1,
    }),
  );
  assert.throws(
    () =>
      assertPromptCipherKeysCoverLiveReferences(removed, ["test-key-a"]),
    cipherUnavailable,
  );
  const removedCipher = new WebCryptoPromptCipher(removed);
  await assert.rejects(
    removedCipher.decrypt(oldEnvelope, context),
    cipherUnavailable,
  );
});

test("cipher enforces exact plaintext bounds and clones key material", async () => {
  const keyring = parsePromptCipherKeyring(
    (await fixture("prompt-keyring-v1.json")).trim(),
  );
  const originalKey = keyring.keys.get("test-key-a");
  assert.ok(originalKey);
  const cipher = new WebCryptoPromptCipher(keyring);
  const cleanCipher = new WebCryptoPromptCipher(
    parsePromptCipherKeyring(
      (await fixture("prompt-keyring-v1.json")).trim(),
    ),
  );
  originalKey.fill(255);
  const clonedEnvelope = await cipher.encrypt(
    encode("still uses the cloned key"),
    context,
  );
  assert.deepEqual(
    await cleanCipher.decrypt(clonedEnvelope, context),
    encode("still uses the cloned key"),
  );
  await assert.rejects(
    cipher.encrypt(new Uint8Array(), context),
    cipherUnavailable,
  );
  await assert.rejects(
    cipher.encrypt(
      new Uint8Array(ENGINE_PROMPT_MAX_BYTES + 1),
      context,
    ),
    cipherUnavailable,
  );
  const maximum = new Uint8Array(ENGINE_PROMPT_MAX_BYTES).fill(1);
  const envelope = await cipher.encrypt(maximum, context);
  assert.deepEqual(await cipher.decrypt(envelope, context), maximum);
});

test("prompt references are opaque, random and closed", () => {
  const first = generatePromptRef();
  const second = generatePromptRef();
  assert.match(first, /^prm_[0-9a-f]{32}$/u);
  assert.match(second, /^prm_[0-9a-f]{32}$/u);
  assert.notEqual(first, second);
  assert.throws(
    () => buildEnginePromptReadSentinel("prm_invalid"),
    /Invalid engine prompt reference/u,
  );
});

test("B4.3f keeps engine execution and erasure adapters inactive", async () => {
  const sources = await Promise.all([
    readFile(
      new URL(
        "../../src/domain/runners/engine-claim-admission.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/domain/runners/engine-prompt-read.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/domain/runners/engine-control-plane.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/adapters/crypto/web-crypto-prompt-cipher.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../../src/ports/prompt-cipher.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /cloudflare:workers|getD1|D1PreparedStatement|child_process|spawn\s*\(|fetch\s*\(/u,
    );
  }
  const repositoryRoot = new URL("../../", import.meta.url);
  const productionFiles = await listTypeScriptFiles(repositoryRoot, [
    ".next",
    "node_modules",
    "tests",
  ]);
  const allowedActivationPaths = new Set([
    "app/api/runs/[runId]/engine-lease/claim/route.ts",
    "app/api/runs/[runId]/prompt/route.ts",
    "app/api/runs/engine/route.ts",
    "src/adapters/d1/run-repository.ts",
    "src/adapters/http/runner-route.ts",
    "src/adapters/http/signed-prompt-read-route.ts",
    "src/adapters/crypto/web-crypto-prompt-cipher.ts",
    "src/domain/runners/engine-prompt-read.ts",
    "src/domain/runners/engine-control-plane.ts",
    "src/ports/prompt-cipher.ts",
  ]);
  for (const relative of productionFiles) {
    if (allowedActivationPaths.has(relative)) continue;
    const source = await readFile(new URL(relative, repositoryRoot), "utf8");
    assert.doesNotMatch(
      source,
      /engine-claim-admission|runners\/engine-prompt-read|engine-control-plane|web-crypto-prompt-cipher|ports\/prompt-cipher/u,
      `engine creation foundation imported by ${relative}`,
    );
  }
});

function streamedRequest(
  chunks: Uint8Array[],
  contentLength?: string,
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("https://nexus.example/api/runs/engine", {
    body,
    headers:
      contentLength === undefined
        ? undefined
        : { "content-length": contentLength },
    method: "POST",
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function flipFirst(value: Uint8Array): Uint8Array {
  const copy = value.slice();
  copy[0] ^= 1;
  return copy;
}

function testKey(byte: number): string {
  let binary = "";
  for (const value of new Uint8Array(32).fill(byte)) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function encodeRawJsonPrompt(promptBytes: Uint8Array): Uint8Array {
  const prefix = encode(
    `{"assignedRunnerId":"rnr_${"a".repeat(32)}","engine":"codex_cli","prompt":"`,
  );
  const suffix = encode('"}');
  const raw = new Uint8Array(
    prefix.byteLength + promptBytes.byteLength + suffix.byteLength,
  );
  raw.set(prefix);
  raw.set(promptBytes, prefix.byteLength);
  raw.set(suffix, prefix.byteLength + promptBytes.byteLength);
  return raw;
}

async function listTypeScriptFiles(
  root: URL,
  ignored: string[],
  current = "",
): Promise<string[]> {
  const entries = await readdir(new URL(current || ".", root), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (ignored.includes(entry.name)) continue;
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(root, ignored, relative)));
    } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

function inputError(
  code: EngineControlPlaneInputError["code"],
  status: EngineControlPlaneInputError["status"],
): (error: unknown) => boolean {
  return (error) =>
    error instanceof EngineControlPlaneInputError &&
    error.code === code &&
    error.status === status;
}

function cipherUnavailable(error: unknown): boolean {
  return (
    error instanceof PromptCipherError &&
    error.code === "prompt_cipher_key_unavailable" &&
    error.status === 503 &&
    error.message === "Prompt cipher is unavailable."
  );
}
