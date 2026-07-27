import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parsePromptCipherKeyring,
  PromptCipherError,
  WebCryptoPromptCipher,
} from "@/src/adapters/crypto/web-crypto-prompt-cipher";
import {
  decodeEngineExcerptBase64Url,
  ENGINE_EXCERPT_REF_PATTERN,
  frameEngineExcerpts,
  generateEngineExcerptRef,
  unframeEngineExcerpts,
} from "@/src/domain/runners/execution-engine";

const runId = `run_${"1".repeat(32)}`;
const organizationId = "org-engine-receipt-unit";
const excerptRef = `exc_${"2".repeat(32)}`;
const promptRef = `prm_${"2".repeat(32)}`;

test("engine excerpts use a deterministic bounded frame with stream separation", () => {
  const stdout = Uint8Array.from([1, 2, 3]);
  const stderr = Uint8Array.from([4, 5]);
  const framed = frameEngineExcerpts(stdout, stderr);
  assert.deepEqual([...framed], [0, 3, 1, 2, 3, 4, 5]);
  assert.deepEqual(unframeEngineExcerpts(framed), { stdout, stderr });

  const maximal = frameEngineExcerpts(
    new Uint8Array(512).fill(6),
    new Uint8Array(512).fill(7),
  );
  assert.equal(maximal.byteLength, 1026);
  assert.deepEqual(unframeEngineExcerpts(maximal), {
    stdout: new Uint8Array(512).fill(6),
    stderr: new Uint8Array(512).fill(7),
  });
  assert.throws(
    () =>
      frameEngineExcerpts(
        new Uint8Array(1024),
        new Uint8Array(1),
      ),
    /Invalid engine excerpts/u,
  );
  assert.throws(
    () => unframeEngineExcerpts(Uint8Array.from([0, 2, 1])),
    /Invalid framed engine excerpts/u,
  );
});

test("excerpt references and base64url decoding are canonical", () => {
  const first = generateEngineExcerptRef();
  const second = generateEngineExcerptRef();
  assert.match(first, ENGINE_EXCERPT_REF_PATTERN);
  assert.match(second, ENGINE_EXCERPT_REF_PATTERN);
  assert.notEqual(first, second);
  assert.deepEqual(
    decodeEngineExcerptBase64Url("AAEC_w"),
    Uint8Array.from([0, 1, 2, 255]),
  );
  assert.throws(
    () => decodeEngineExcerptBase64Url("AAEC_w=="),
    /Invalid engine excerpt/u,
  );
});

test("excerpt AAD is cryptographically distinct from prompt AAD", async () => {
  const keyring = parsePromptCipherKeyring(
    (
      await readFile(
        new URL("../fixtures/s6-b4/prompt-keyring-v1.json", import.meta.url),
        "utf8",
      )
    ).trim(),
  );
  const cipher = new WebCryptoPromptCipher(keyring);
  const framed = frameEngineExcerpts(
    new TextEncoder().encode("stdout"),
    new TextEncoder().encode("stderr"),
  );
  const excerptContext = { runId, organizationId, payloadRef: excerptRef };
  const promptContext = { runId, organizationId, payloadRef: promptRef };
  const excerptEnvelope = await cipher.encrypt(framed, excerptContext);
  assert.deepEqual(
    await cipher.decrypt(excerptEnvelope, excerptContext),
    framed,
  );
  await assert.rejects(
    cipher.decrypt(excerptEnvelope, promptContext),
    (error: unknown) => error instanceof PromptCipherError,
  );

  const promptEnvelope = await cipher.encrypt(framed, promptContext);
  await assert.rejects(
    cipher.decrypt(promptEnvelope, excerptContext),
    (error: unknown) => error instanceof PromptCipherError,
  );
  assert.equal(ENGINE_EXCERPT_REF_PATTERN.test(excerptRef), true);
});

test("SQL and domain share the canonical empty-stream digest", async () => {
  const migration = await readFile(
    new URL("../../drizzle/0026_sticky_valkyrie.sql", import.meta.url),
    "utf8",
  );
  const emptySha256 = createHash("sha256").update(new Uint8Array()).digest(
    "hex",
  );
  assert.equal(
    emptySha256,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(migration.split(emptySha256).length - 1, 4);
});

test("retention and live-key coverage include both protected payload kinds", async () => {
  const repository = await readFile(
    new URL(
      "../../src/adapters/d1/prompt-retention-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    repository,
    /listDuePrompts\(cutoff, limit \+ 1\)[\s\S]*listDueEngineExcerpts\(cutoff, limit \+ 1\)/u,
  );
  assert.match(
    repository,
    /FROM run_prompts[\s\S]*UNION[\s\S]*FROM run_engine_excerpts/u,
  );
  assert.match(
    repository,
    /UPDATE run_engine_excerpts[\s\S]*SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL/u,
  );
  assert.doesNotMatch(
    repository,
    /PromptCipher|resolvePromptCipherKeyring|WebCryptoPromptCipher/u,
  );
});
