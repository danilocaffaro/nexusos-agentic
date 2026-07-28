import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  writeEngineConfiguration,
} from "../runner/engine-config-store.mjs";
import {
  resolveFreshEngineExecutionReadiness,
} from "../runner/nexus-runner.mjs";

test("execution readiness rereads engine configuration for every spawn gate", async (t) => {
  const created = await mkdtemp(join(tmpdir(), "nexus-fresh-ready-"));
  const stateDir = await realpath(created);
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { force: true, recursive: true }));

  const input = {
    engine: "claude_code_cli",
    expectedVersion: "2.1.219 (Claude Code)",
    stateDir,
  };
  assert.deepEqual(
    await resolveFreshEngineExecutionReadiness(input),
    {
      kind: "not_ready",
      reason: "engine_not_configured",
    },
  );

  const executablePath = join(stateDir, "claude-fixture");
  await writeFile(
    executablePath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.219 (Claude Code)'
elif [ "$1" = "--help" ]; then
  printf '%s\\n' '--print --safe-mode --disable-slash-commands --no-chrome --no-session-persistence --permission-mode --tools --strict-mcp-config --mcp-config --settings --output-format --prompt-suggestions'
elif [ "$1" = "auth" ]; then
  printf '%s\\n' '{"loggedIn":true}'
else
  cat >/dev/null
  printf '%s\\n' 'NEXUS_CANARY_TOOLS_DISABLED_V1'
fi
`,
    { mode: 0o700 },
  );
  await chmod(executablePath, 0o700);
  await writeEngineConfiguration(stateDir, {
    engines: {
      claude_code_cli: { executablePath },
    },
    schemaVersion: 1,
  });

  assert.deepEqual(
    await resolveFreshEngineExecutionReadiness({
      ...input,
      leaseExpiresAt: new Date(Date.now() + 1_000).toISOString(),
    }),
    {
      kind: "not_ready",
      reason: "engine_lease_horizon_exhausted",
    },
  );

  const ready = await resolveFreshEngineExecutionReadiness(input);
  assert.equal(ready.kind, "ready", JSON.stringify(ready));
  assert.equal(ready.engine, "claude_code_cli");
  assert.equal(ready.engineVersion, "2.1.219 (Claude Code)");
  assert.equal(ready.executableRealPath, executablePath);
  assert.equal(Object.isFrozen(ready), true);
  const scratchPrefix = `.nexus-engine-probe-${createHash("sha256")
    .update(stateDir)
    .digest("hex")
    .slice(0, 16)}-`;
  assert.equal(
    (await readdir(dirname(stateDir))).some((name) =>
      name.startsWith(scratchPrefix)
    ),
    false,
  );

  await writeFile(
    executablePath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.219 (Claude Code)'
elif [ "$1" = "--help" ]; then
  printf '%s\\n' '--print --safe-mode --disable-slash-commands --no-chrome --no-session-persistence --permission-mode --tools --strict-mcp-config --mcp-config --settings --output-format --prompt-suggestions'
elif [ "$1" = "auth" ]; then
  printf '%s\\n' '{"loggedIn":true}'
else
  cat >/dev/null
  printf '%s\\n' 'unexpected canary output'
fi
`,
    { mode: 0o700 },
  );
  await chmod(executablePath, 0o700);
  assert.deepEqual(
    await resolveFreshEngineExecutionReadiness(input),
    {
      kind: "not_ready",
      reason: "engine_acceptance_canary_failed",
    },
  );
  assert.equal(
    (await readdir(dirname(stateDir))).some((name) =>
      name.startsWith(scratchPrefix)
    ),
    false,
  );
});
