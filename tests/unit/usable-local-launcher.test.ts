import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const launcherSource = readFileSync(
  new URL("../../scripts/usable-local.mjs", import.meta.url),
  "utf8",
);

test("local launcher retains signal handlers for bounded escalation", () => {
  assert.match(
    launcherSource,
    /process\.on\("SIGINT", \(\) => requestShutdown\("SIGINT"\)\)/u,
  );
  assert.match(
    launcherSource,
    /process\.on\("SIGTERM", \(\) => requestShutdown\("SIGTERM"\)\)/u,
  );
  assert.doesNotMatch(launcherSource, /process\.once\("SIG(?:INT|TERM)"/u);
  assert.match(launcherSource, /terminateChild\(activeChild, "SIGKILL"\)/u);
  assert.match(launcherSource, /await terminateAndWait\(failedChild, "SIGTERM"\)/u);
});

test("interrupted startup gives an explicit idempotent recovery action", () => {
  assert.match(
    launcherSource,
    /Rerun local:ready to resume any pending migrations safely/u,
  );
  assert.match(launcherSource, /process\.exitCode = signalExitCode/u);
});
