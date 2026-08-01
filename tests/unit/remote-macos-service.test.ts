import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(
  new URL("../../scripts/remote-macos-service.mjs", import.meta.url),
  "utf8",
);

test("persistent tunnel key leaves the macOS Documents privacy boundary", () => {
  assert.match(serviceSource, /"Application Support",\s*"NexusOS"/u);
  assert.match(serviceSource, /lstatSync\(serviceKeyPath\)/u);
  assert.match(serviceSource, /copyFileSync\(keyPath, serviceKeyPath\)/u);
  assert.match(serviceSource, /chmodSync\(serviceKeyPath, 0o600\)/u);
  assert.match(serviceSource, /"-i",\s*serviceKeyPath/u);
});

test("reinstall waits for launchd to release each label", () => {
  assert.match(serviceSource, /await waitForServiceRemoval\(launchTarget\)/u);
  assert.match(serviceSource, /Date\.now\(\) \+ 5_000/u);
  assert.match(serviceSource, /did not unload within 5 seconds/u);
});

test("persistent tunnel remains fail closed", () => {
  assert.match(serviceSource, /"ExitOnForwardFailure=yes"/u);
  assert.match(serviceSource, /"StrictHostKeyChecking=yes"/u);
  assert.match(serviceSource, /127\.0\.0\.1:\$\{options\.remotePort\}/u);
});
