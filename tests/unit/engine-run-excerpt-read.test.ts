import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parsePromptCipherKeyring,
  WebCryptoPromptCipher,
} from "../../src/adapters/crypto/web-crypto-prompt-cipher";
import {
  readEngineRunExcerptWithPorts,
  type EngineRunExcerptStorageSnapshot,
} from "../../src/adapters/d1/engine-run-excerpt-repository";
import type { RequestIdentity } from "../../src/adapters/identity/request-identity";
import {
  ENGINE_RUN_EXCERPT_MAX_BYTES,
} from "../../src/contracts/engine-run-excerpts";
import { sha256Bytes } from "../../src/domain/governance/crypto";
import {
  frameEngineExcerpts,
} from "../../src/domain/runners/execution-engine";
import type { PromptCipher } from "../../src/ports/prompt-cipher";

const runId = `run_${"1".repeat(32)}`;
const excerptRef = `exc_${"2".repeat(32)}`;
const organizationId = "org-engine-excerpt-owner";
const recordedAt = "2026-07-28T12:00:00.000Z";
const erasedAt = "2026-08-27T12:00:00.000Z";
const keyring = parsePromptCipherKeyring(
  '{"activeKeyId":"test-key-a","keys":{"test-key-a":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","test-key-b":"ERERERERERERERERERERERERERERERERERERERERERE"},"schemaVersion":1}',
);
const AUTHZ_ERROR = new Error("workspace_owner_required");
const NOT_FOUND_ERROR = new Error("engine_run_not_found");
const CRYPTO_ERROR = Object.assign(
  new Error("prompt_cipher_key_unavailable"),
  { code: "prompt_cipher_key_unavailable", status: 503 },
);
const identity: RequestIdentity = {
  id: "principal-owner",
  kind: "human",
  displayName: "Owner",
  organizationId,
};

test("authorization completes before protected lookup or cipher access", async () => {
  const calls: string[] = [];
  await assert.rejects(
    readEngineRunExcerptWithPorts(
      identity,
      runId,
      () => {
        calls.push("cipher");
        return new WebCryptoPromptCipher(keyring);
      },
      {
        authorizeOwner: async () => {
          calls.push("authorize");
          throw AUTHZ_ERROR;
        },
        loadSnapshot: async () => {
          calls.push("load");
          return null;
        },
        notFoundError: () => NOT_FOUND_ERROR,
        cryptoError: () => CRYPTO_ERROR,
      },
    ),
    (error: unknown) => error === AUTHZ_ERROR,
  );
  assert.deepEqual(calls, ["authorize"]);
});

test("cross-tenant and invalid run reads are 404 with zero cipher access", async () => {
  for (const targetRunId of [runId, "not-a-run"]) {
    const calls: string[] = [];
    await assert.rejects(
      readEngineRunExcerptWithPorts(
        identity,
        targetRunId,
        () => {
          calls.push("cipher");
          return new WebCryptoPromptCipher(keyring);
        },
        {
          authorizeOwner: async () => {
            calls.push("authorize");
          },
          loadSnapshot: async (tenant, selectedRunId) => {
            calls.push(`load:${tenant}:${selectedRunId}`);
            return null;
          },
          notFoundError: () => NOT_FOUND_ERROR,
          cryptoError: () => CRYPTO_ERROR,
        },
      ),
      (error: unknown) => error === NOT_FOUND_ERROR,
    );
    assert.equal(calls[0], "authorize");
    assert.equal(calls.includes("cipher"), false);
    if (targetRunId === runId) {
      assert.deepEqual(calls, [
        "authorize",
        `load:${organizationId}:${runId}`,
      ]);
    } else {
      assert.deepEqual(calls, ["authorize"]);
    }
  }
});

test("absent means both receipt and protected payload are absent", async () => {
  let cipherCalls = 0;
  const view = await readEngineRunExcerptWithPorts(
    identity,
    runId,
    () => {
      cipherCalls += 1;
      return new WebCryptoPromptCipher(keyring);
    },
    portsFor(absentSnapshot()),
  );
  assert.deepEqual(view, {
    schemaVersion: 1,
    runId,
    state: "absent",
  });
  assert.equal(cipherCalls, 0);
  assert.equal(Object.isFrozen(view), true);
});

test("erased preserves immutable receipt pins without cipher access", async () => {
  const stored = await storedFixture();
  let cipherCalls = 0;
  const view = await readEngineRunExcerptWithPorts(
    identity,
    runId,
    () => {
      cipherCalls += 1;
      return new WebCryptoPromptCipher(keyring);
    },
    portsFor({
      ...stored.snapshot,
      key_id: null,
      iv: null,
      ciphertext: null,
      tag: null,
      erased_at: erasedAt,
    }),
  );
  assert.equal(view.state, "erased");
  if (view.state !== "erased") return;
  assert.equal(view.erasedAt, erasedAt);
  assert.deepEqual(view.receipt, stored.receipt);
  assert.equal(cipherCalls, 0);
  assert.equal(Object.isFrozen(view.receipt.stdout), true);
});

test("stored round-trips arbitrary bytes as separated base64url only", async () => {
  const stored = await storedFixture();
  const view = await readEngineRunExcerptWithPorts(
    identity,
    runId,
    () => new WebCryptoPromptCipher(keyring),
    portsFor(stored.snapshot),
  );
  assert.equal(view.state, "stored");
  if (view.state !== "stored") return;
  assert.equal(view.encoding, "base64url");
  assert.equal(view.interpretation, "opaque_bytes");
  assert.deepEqual(decodeBase64Url(view.stdoutBase64Url), stored.stdout);
  assert.deepEqual(decodeBase64Url(view.stderrBase64Url), stored.stderr);
  assert.deepEqual(view.receipt, stored.receipt);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.receipt), true);
});

test("decrypted and unframed byte buffers are scrubbed after projection", async () => {
  const stored = await storedFixture();
  const decrypted = frameEngineExcerpts(stored.stdout, stored.stderr);
  const view = await readEngineRunExcerptWithPorts(
    identity,
    runId,
    () => ({
      decrypt: async () => decrypted,
      encrypt: async () => {
        throw new Error("unused");
      },
    }),
    portsFor(stored.snapshot),
  );
  assert.equal(view.state, "stored");
  assert.equal(decrypted.every((byte) => byte === 0), true);
});

test("unknown key, bad tag, wrong AAD and cipher faults are one sanitized 503", async () => {
  const stored = await storedFixture();
  const badTag = protectedBytes(stored.snapshot.tag);
  badTag[0] ^= 0xff;
  const foreignAad = await storedFixture({
    organizationId: "org-other",
  });
  const retiredKeyring = parsePromptCipherKeyring(
    '{"activeKeyId":"test-key-b","keys":{"test-key-b":"ERERERERERERERERERERERERERERERERERERERERERE"},"schemaVersion":1}',
  );
  const cases: Array<{
    snapshot: EngineRunExcerptStorageSnapshot;
    cipher: () => PromptCipher;
  }> = [
    {
      snapshot: stored.snapshot,
      cipher: () => new WebCryptoPromptCipher(retiredKeyring),
    },
    {
      snapshot: { ...stored.snapshot, tag: badTag },
      cipher: () => new WebCryptoPromptCipher(keyring),
    },
    {
      snapshot: foreignAad.snapshot,
      cipher: () => new WebCryptoPromptCipher(keyring),
    },
    {
      snapshot: stored.snapshot,
      cipher: () => ({
        decrypt: async () => {
          throw new Error("secret provider detail");
        },
        encrypt: async () => {
          throw new Error("unused");
        },
      }),
    },
  ];
  for (const vector of cases) {
    await assert.rejects(
      readEngineRunExcerptWithPorts(
        identity,
        runId,
        vector.cipher,
        portsFor(vector.snapshot),
      ),
      (error: unknown) => error === CRYPTO_ERROR,
    );
  }
});

test("partial state, digest mismatch and bounds fail closed, never absent", async () => {
  const stored = await storedFixture();
  const cases = [
    {
      ...stored.snapshot,
      receipt_run_id: null,
    },
    {
      ...stored.snapshot,
      receipt_excerpt_sha256: "f".repeat(64),
    },
    {
      ...stored.snapshot,
      receipt_stdout_bytes: ENGINE_RUN_EXCERPT_MAX_BYTES,
      receipt_stdout_excerpt_bytes: ENGINE_RUN_EXCERPT_MAX_BYTES,
      receipt_stderr_bytes: 1,
      receipt_stderr_excerpt_bytes: 1,
      payload_stdout_excerpt_bytes: ENGINE_RUN_EXCERPT_MAX_BYTES,
      payload_stderr_excerpt_bytes: 1,
    },
  ];
  for (const snapshot of cases) {
    let cipherCalls = 0;
    await assert.rejects(
      readEngineRunExcerptWithPorts(
        identity,
        runId,
        () => {
          cipherCalls += 1;
          return new WebCryptoPromptCipher(keyring);
        },
        portsFor(snapshot),
      ),
      (error: unknown) => error === CRYPTO_ERROR,
    );
    assert.equal(cipherCalls <= 1, true);
  }
});

test("route and repository freeze authz, tenancy and no-interpretation wiring", () => {
  const route = readFileSync(
    "app/api/runs/engine/[runId]/excerpt/route.ts",
    "utf8",
  );
  const repository = readFileSync(
    "src/adapters/d1/engine-run-excerpt-repository.ts",
    "utf8",
  );
  const authorizeAt = repository.indexOf(
    "await ports.authorizeOwner(identity)",
  );
  const loadAt = repository.indexOf(
    "await ports.loadSnapshot(identity.organizationId, runId)",
  );
  assert.equal(authorizeAt >= 0 && loadAt > authorizeAt, true);
  assert.match(repository, /run\.organization_id = \?/);
  assert.match(repository, /receipt\.organization_id = run\.organization_id/);
  assert.match(repository, /excerpt\.organization_id = run\.organization_id/);
  assert.doesNotMatch(
    repository,
    /TextDecoder|innerHTML|console\.|run_events|ledger_entries/u,
  );
  assert.match(route, /params: Promise<\{ runId: string \}>/);
  assert.match(route, /await context\.params/);
  assert.match(route, /runnerWorkspaceRoute/);
  assert.doesNotMatch(route, /runtime\s*=\s*["']edge["']/u);
});

function portsFor(snapshot: EngineRunExcerptStorageSnapshot) {
  return {
    authorizeOwner: async () => undefined,
    loadSnapshot: async () => snapshot,
    notFoundError: () => NOT_FOUND_ERROR,
    cryptoError: () => CRYPTO_ERROR,
  };
}

function absentSnapshot(): EngineRunExcerptStorageSnapshot {
  return {
    run_id: runId,
    receipt_run_id: null,
    excerpt_run_id: null,
    receipt_excerpt_ref: null,
    receipt_excerpt_sha256: null,
    receipt_sha256: null,
    recorded_at: null,
    receipt_stdout_bytes: null,
    receipt_stdout_sha256: null,
    receipt_stdout_truncated: null,
    receipt_stdout_excerpt_bytes: null,
    receipt_stderr_bytes: null,
    receipt_stderr_sha256: null,
    receipt_stderr_truncated: null,
    receipt_stderr_excerpt_bytes: null,
    payload_excerpt_ref: null,
    payload_excerpt_sha256: null,
    cipher_version: null,
    key_id: null,
    iv: null,
    ciphertext: null,
    tag: null,
    payload_stdout_excerpt_bytes: null,
    payload_stderr_excerpt_bytes: null,
    payload_created_at: null,
    erased_at: null,
  };
}

async function storedFixture(
  contextPatch: Partial<{
    organizationId: string;
    payloadRef: string;
    runId: string;
  }> = {},
) {
  const stdout = Uint8Array.from([0xff, 0xfe, 0x1b, 0x5b, 0x31, 0x6d]);
  const stderr = Uint8Array.from([0, 0x80, 0x1b, 0x3c, 0x3e]);
  const framed = frameEngineExcerpts(stdout, stderr);
  const cipher = new WebCryptoPromptCipher(keyring);
  const envelope = await cipher.encrypt(framed, {
    organizationId,
    payloadRef: excerptRef,
    runId,
    ...contextPatch,
  });
  const [excerptDigest, stdoutDigest, stderrDigest] = await Promise.all([
    sha256Bytes(framed),
    sha256Bytes(stdout),
    sha256Bytes(stderr),
  ]);
  const receipt = {
    excerptRef,
    excerptSha256: excerptDigest.hex,
    receiptSha256: "a".repeat(64),
    recordedAt,
    stdout: {
      bytes: stdout.byteLength,
      excerptBytes: stdout.byteLength,
      sha256: stdoutDigest.hex,
      truncated: false,
    },
    stderr: {
      bytes: stderr.byteLength,
      excerptBytes: stderr.byteLength,
      sha256: stderrDigest.hex,
      truncated: false,
    },
  };
  const snapshot: EngineRunExcerptStorageSnapshot = {
    run_id: runId,
    receipt_run_id: runId,
    excerpt_run_id: runId,
    receipt_excerpt_ref: excerptRef,
    receipt_excerpt_sha256: receipt.excerptSha256,
    receipt_sha256: receipt.receiptSha256,
    recorded_at: recordedAt,
    receipt_stdout_bytes: receipt.stdout.bytes,
    receipt_stdout_sha256: receipt.stdout.sha256,
    receipt_stdout_truncated: 0,
    receipt_stdout_excerpt_bytes: receipt.stdout.excerptBytes,
    receipt_stderr_bytes: receipt.stderr.bytes,
    receipt_stderr_sha256: receipt.stderr.sha256,
    receipt_stderr_truncated: 0,
    receipt_stderr_excerpt_bytes: receipt.stderr.excerptBytes,
    payload_excerpt_ref: excerptRef,
    payload_excerpt_sha256: receipt.excerptSha256,
    cipher_version: envelope.cipherVersion,
    key_id: envelope.keyId,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
    payload_stdout_excerpt_bytes: receipt.stdout.excerptBytes,
    payload_stderr_excerpt_bytes: receipt.stderr.excerptBytes,
    payload_created_at: recordedAt,
    erased_at: null,
  };
  return { snapshot, receipt, stdout, stderr };
}

function protectedBytes(
  value: ArrayBuffer | ArrayBufferView | number[] | null,
): Uint8Array {
  assert.notEqual(value, null);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ),
    );
  }
  return Uint8Array.from(value as number[]);
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) =>
    character.charCodeAt(0),
  );
}
