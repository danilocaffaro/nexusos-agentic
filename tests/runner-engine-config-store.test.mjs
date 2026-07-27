import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  engineConfigurationPath,
  EngineConfigStoreError,
  readEngineConfiguration,
  writeEngineConfiguration,
} from "../runner/engine-config-store.mjs";

const configured = {
  engines: {
    claude_code_cli: {
      executablePath: "/opt/nexus/bin/claude",
    },
    codex_cli: {
      executablePath: "/opt/nexus/bin/codex",
    },
  },
  schemaVersion: 1,
};

test("missing engine configuration is empty without creating a file", async (t) => {
  const stateDir = await fixture(t);
  assert.deepEqual(await readEngineConfiguration(stateDir), {
    engines: {},
    schemaVersion: 1,
  });
  await assert.rejects(stat(engineConfigurationPath(stateDir)), {
    code: "ENOENT",
  });
});

test("engine configuration writes are canonical, durable and replaceable", async (t) => {
  const stateDir = await fixture(t);
  await writeEngineConfiguration(stateDir, configured);
  const path = engineConfigurationPath(stateDir);
  assert.equal(
    await readFile(path, "utf8"),
    '{"engines":{"claude_code_cli":{"executablePath":"/opt/nexus/bin/claude"},"codex_cli":{"executablePath":"/opt/nexus/bin/codex"}},"schemaVersion":1}\n',
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readEngineConfiguration(stateDir), configured);

  const empty = { engines: {}, schemaVersion: 1 };
  await writeEngineConfiguration(stateDir, empty);
  assert.equal(
    await readFile(path, "utf8"),
    '{"engines":{},"schemaVersion":1}\n',
  );
  assert.deepEqual(await readEngineConfiguration(stateDir), empty);
  assert.deepEqual(
    (await readdir(stateDir)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("engine configuration reads fail closed on unsafe local files", async (t) => {
  const stateDir = await fixture(t);
  const path = engineConfigurationPath(stateDir);
  const canonical = '{"engines":{},"schemaVersion":1}\n';

  await writeFile(path, canonical, { mode: 0o644 });
  await assertInvalid(() => readEngineConfiguration(stateDir));
  await chmod(path, 0o600);
  await writeFile(path, '{ "engines": {}, "schemaVersion": 1 }\n');
  await assertInvalid(() => readEngineConfiguration(stateDir));
  await writeFile(path, "x".repeat(4_097));
  await assertInvalid(() => readEngineConfiguration(stateDir));

  await unlink(path);
  const target = join(stateDir, "target.json");
  await writeFile(target, canonical, { mode: 0o600 });
  await symlink(target, path);
  await assertInvalid(() => readEngineConfiguration(stateDir));
});

test("engine configuration writes reject noncanonical paths", async (t) => {
  const stateDir = await fixture(t);
  for (const executablePath of [
    "codex",
    "/opt/../bin/codex",
    "/opt//bin/codex",
    "/opt/bin/codex\nhidden",
  ]) {
    await assertInvalid(() =>
      writeEngineConfiguration(stateDir, {
        engines: { codex_cli: { executablePath } },
        schemaVersion: 1,
      }),
    );
  }
});

async function fixture(t) {
  const stateDir = await mkdtemp(
    join(process.cwd(), ".nexus-engine-config-"),
  );
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

async function assertInvalid(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof EngineConfigStoreError, true);
    assert.equal(error.code, "engine_config_invalid");
    assert.equal(error.message.includes("/opt/"), false);
    return true;
  });
}
