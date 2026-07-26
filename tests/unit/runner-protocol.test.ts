import assert from "node:assert/strict";
import test from "node:test";
import { deriveRunnerLiveness } from "../../src/domain/runners/liveness";
import {
  buildRunnerStringToSign,
  decodeCanonicalBase64Url,
  deriveRunnerIdentity,
  encodeBase64Url,
  generateRunnerToken,
  hashRunnerToken,
  hasValidRunnerTimestamp,
  isHeartbeatBody,
  publicKeyFingerprint,
  RUNNER_HEARTBEAT_BODY,
  verifyRunnerSignature,
} from "../../src/domain/runners/runner-protocol";

test("runner protocol encodes fixed-size values as canonical base64url", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const encoded = encodeBase64Url(bytes);
  assert.equal(encoded.length, 43);
  assert.deepEqual(decodeCanonicalBase64Url(encoded, 32), bytes);
  assert.equal(decodeCanonicalBase64Url(`${encoded}=`, 32), undefined);
  const urlAlphabet = encodeBase64Url(new Uint8Array(32).fill(255));
  assert.equal(
    decodeCanonicalBase64Url(urlAlphabet.replaceAll("_", "/"), 32),
    undefined,
  );
  assert.equal(decodeCanonicalBase64Url(encoded.slice(0, -1), 32), undefined);

  const token = generateRunnerToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(decodeCanonicalBase64Url(token, 32)?.byteLength, 32);
});

test("runner identity is deterministic and domain-separated", async () => {
  const token = encodeBase64Url(new Uint8Array(32).fill(7));
  const tokenHash = await hashRunnerToken(token);
  assert.ok(tokenHash);
  const publicKey = encodeBase64Url(new Uint8Array(32).fill(9));
  const first = await deriveRunnerIdentity(tokenHash, publicKey);
  const second = await deriveRunnerIdentity(tokenHash, publicKey);

  assert.deepEqual(first, second);
  assert.match(first.runnerId, /^rnr_[0-9a-f]{32}$/u);
  assert.match(first.principalId, /^prn_[0-9a-f]{32}$/u);
  assert.notEqual(first.runnerId.slice(4), first.principalId.slice(4));
  assert.notDeepEqual(
    first,
    await deriveRunnerIdentity(tokenHash, encodeBase64Url(new Uint8Array(32).fill(10))),
  );
});

test("runner signing input binds exact request bytes and has no trailing LF", async () => {
  const signed = await buildRunnerStringToSign({
    domain: "nexus-runner-enroll-v1",
    method: "POST",
    pathname: "/api/runners/enroll",
    audience: "https://nexus.example",
    timestamp: "2026-07-26T12:34:56.789Z",
    nonce: encodeBase64Url(new Uint8Array(16).fill(3)),
    body: new TextEncoder().encode('{"displayName":"Runner 1"}'),
  });

  assert.equal(
    signed.value,
    [
      "nexus-runner-enroll-v1",
      "POST",
      "/api/runners/enroll",
      "https://nexus.example",
      "2026-07-26T12:34:56.789Z",
      "AwMDAwMDAwMDAwMDAwMDAw",
      "sha256:2d007976743f5db8fa6af0db50a64fe0525655f030543285bfea26a693b0f169",
    ].join("\n"),
  );
  assert.equal(signed.value.endsWith("\n"), false);
  assert.match(signed.hash, /^[0-9a-f]{64}$/u);
});

test("runner signatures verify exact domain, path, audience, body and headers", async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKey = encodeBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const timestamp = "2026-07-26T12:34:56.789Z";
  const nowMs = Date.parse(timestamp);
  const nonce = encodeBase64Url(new Uint8Array(16).fill(4));
  const signatureInput = {
    domain: "nexus-runner-enroll-v1" as const,
    method: "POST" as const,
    pathname: "/api/runners/enroll",
    audience: "https://nexus.example",
    body: new TextEncoder().encode('{"displayName":"Runner 1"}'),
  };
  const stringToSign = await buildRunnerStringToSign({
    ...signatureInput,
    timestamp,
    nonce,
  });
  const signature = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        pair.privateKey,
        new TextEncoder().encode(stringToSign.value),
      ),
    ),
  );

  assert.deepEqual(
    await verifyRunnerSignature({
      signatureInput,
      publicKey,
      signature,
      timestamp,
      nonce,
      nowMs,
    }),
    {
      publicKey,
      nonce,
      timestamp,
      requestHash: stringToSign.hash,
      stringToSign: stringToSign.value,
    },
  );
  for (const changed of [
    { ...signatureInput, pathname: "/api/runners/enroll/" },
    { ...signatureInput, audience: "https://spoof.example" },
    { ...signatureInput, body: new TextEncoder().encode("{}") },
    { ...signatureInput, domain: "nexus-runner-heartbeat-v1" as const },
  ]) {
    assert.equal(
      await verifyRunnerSignature({
        signatureInput: changed,
        publicKey,
        signature,
        timestamp,
        nonce,
        nowMs,
      }),
      undefined,
    );
  }
  assert.match((await publicKeyFingerprint(publicKey)) ?? "", /^SHA256:/u);
});

test("runner signatures reject low-order keys and malformed values", async () => {
  const identityKey = encodeBase64Url(
    Uint8Array.from([1, ...new Uint8Array(31)]),
  );
  const input = {
    signatureInput: {
      domain: "nexus-runner-enroll-v1" as const,
      method: "POST" as const,
      pathname: "/api/runners/enroll",
      audience: "https://nexus.example",
      body: new TextEncoder().encode("{}"),
    },
    publicKey: identityKey,
    signature: encodeBase64Url(new Uint8Array(64)),
    timestamp: "2026-07-26T12:34:56.789Z",
    nonce: encodeBase64Url(new Uint8Array(16)),
    nowMs: Date.parse("2026-07-26T12:34:56.789Z"),
  };
  assert.equal(await verifyRunnerSignature(input), undefined);
  assert.equal(
    await verifyRunnerSignature({ ...input, publicKey: `${identityKey}=` }),
    undefined,
  );
  assert.equal(
    await verifyRunnerSignature({ ...input, nonce: "not-a-nonce" }),
    undefined,
  );
});

test("runner timestamp, heartbeat body and liveness use exact boundaries", () => {
  const now = Date.parse("2026-07-26T12:35:00.000Z");
  assert.equal(
    hasValidRunnerTimestamp("2026-07-26T12:34:00.000Z", now),
    true,
  );
  assert.equal(
    hasValidRunnerTimestamp("2026-07-26T12:33:59.999Z", now),
    false,
  );
  assert.equal(
    hasValidRunnerTimestamp("2026-07-26T12:35:30.000Z", now),
    true,
  );
  assert.equal(
    hasValidRunnerTimestamp("2026-07-26T12:35:30.001Z", now),
    false,
  );
  assert.equal(
    hasValidRunnerTimestamp("2026-07-26T12:35:00Z", now),
    false,
  );
  assert.equal(
    hasValidRunnerTimestamp("2026-07-26T09:35:00.000-03:00", now),
    false,
  );
  assert.equal(isHeartbeatBody(RUNNER_HEARTBEAT_BODY), true);
  assert.equal(isHeartbeatBody(new TextEncoder().encode("{ }")), false);

  assert.equal(
    deriveRunnerLiveness({ status: "active", nowMs: now }),
    "pending",
  );
  for (const [seconds, expected] of [
    [89, "online"],
    [90, "stale"],
    [599, "stale"],
    [600, "offline"],
  ] as const) {
    assert.equal(
      deriveRunnerLiveness({
        status: "active",
        lastSeenAt: new Date(now - seconds * 1000).toISOString(),
        nowMs: now,
      }),
      expected,
    );
  }
  assert.equal(
    deriveRunnerLiveness({
      status: "revoked",
      lastSeenAt: new Date(now).toISOString(),
      nowMs: now,
    }),
    "revoked",
  );
});
