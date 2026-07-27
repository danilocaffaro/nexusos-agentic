import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL(
    "../../src/adapters/http/signed-prompt-read-route.ts",
    import.meta.url,
  ),
  "utf8",
);

test("prompt-read transport pins the frozen signed-control preamble", () => {
  assert.match(source, /if \(url\.search\) throw runnerRejected\(\)/u);
  assert.equal(
    source.includes("!/^[1-9]\\d{0,3}$/u.test(declaredLength)"),
    true,
  );
  assert.match(source, /Number\(declaredLength\) > 4_096/u);
  assert.match(
    source,
    /raw\.byteLength !== Number\(declaredLength\)/u,
  );
  assert.match(source, /parse\(raw\)/u);
  assert.match(source, /x-nexus-runner-id/u);
  assert.match(source, /x-nexus-signature/u);
  assert.match(source, /x-nexus-timestamp/u);
  assert.match(source, /x-nexus-nonce/u);
  assert.match(
    source,
    /domain: "nexus-runner-engine-prompt-read-v1"/u,
  );
  assert.match(source, /verifyRunnerSignature/u);
});

test("prompt-read transport exposes plaintext only as closed binary output", () => {
  assert.match(source, /"content-type": "application\/octet-stream"/u);
  assert.match(source, /"cache-control": "no-store"/u);
  assert.match(source, /"x-content-type-options": "nosniff"/u);
  assert.match(source, /"x-nexus-prompt-bytes"/u);
  assert.match(source, /"x-nexus-prompt-ref"/u);
  assert.match(source, /"x-nexus-prompt-sha256"/u);
  assert.doesNotMatch(source, /canonicalJson\(result\.body/u);
  assert.doesNotMatch(source, /console\./u);
});
