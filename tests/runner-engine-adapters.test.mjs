import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  createEngineFilesystemAdapter,
  createEngineProcessAdapter,
} from "../runner/engine-adapters.mjs";
import {
  validateEngineBinary,
  validateEngineProbeDirectory,
} from "../runner/engine-probes.mjs";

const supported = ["darwin", "linux"].includes(process.platform);

test(
  "real filesystem adapter preserves exact inode facts and no-follow identity",
  { skip: !supported },
  async (t) => {
    const fixture = await safeFixture(t);
    const executable = join(fixture.bin, "engine");
    const configured = join(fixture.root, "configured-engine");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(executable, configured);
    const adapter = createEngineFilesystemAdapter();
    const facts = await adapter.lstat(executable);
    assert.equal(typeof facts.dev, "string");
    assert.equal(typeof facts.ino, "string");
    assert.equal(facts.kind, "file");
    assert.equal(Number.isSafeInteger(facts.mode), true);
    const validated = await validateEngineBinary(
      {
        configuredPath: configured,
        ...effectiveIdentity(),
      },
      adapter,
    );
    assert.equal(validated.kind, "valid");
    assert.equal(validated.realPath, executable);
    await assert.rejects(adapter.openNoFollow(configured));
  },
);

test(
  "real filesystem adapter opens a raced fifo without blocking",
  { skip: !supported },
  async (t) => {
    const fixture = await safeFixture(t);
    const fifo = join(fixture.bin, "probe-fifo");
    const result = spawnSync("mkfifo", [fifo]);
    if (result.error || result.status !== 0) {
      t.skip("mkfifo is unavailable");
      return;
    }
    const adapter = createEngineFilesystemAdapter();
    const opened = await adapter.openNoFollow(fifo);
    try {
      assert.equal(opened.facts.kind, "other");
    } finally {
      await opened.close();
    }
  },
);

test(
  "probe cwd requires a private leaf and safe resolved parents",
  { skip: !supported },
  async (t) => {
    const fixture = await safeFixture(t);
    const adapter = createEngineFilesystemAdapter();
    assert.deepEqual(
      await validateEngineProbeDirectory(
        { ...effectiveIdentity(), path: fixture.bin },
        adapter,
      ),
      { kind: "valid", realPath: fixture.bin },
    );

    const shared = join(fixture.root, "shared");
    const privateChild = join(shared, "private");
    await mkdir(shared, { mode: 0o770 });
    await chmod(shared, 0o770);
    await mkdir(privateChild, { mode: 0o700 });
    assert.deepEqual(
      await validateEngineProbeDirectory(
        { ...effectiveIdentity(), path: privateChild },
        adapter,
      ),
      { kind: "invalid" },
    );
  },
);

test(
  "real process adapter closes stdin and exposes only literal env and cwd",
  { skip: !supported },
  async (t) => {
    const fixture = await safeFixture(t);
    const adapter = createEngineProcessAdapter();
    const script = await writeScript(
      fixture,
      "literal-process.mjs",
      `let data = "";
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    cwd: process.cwd(),
    env: process.env,
    stdinBytes: Buffer.byteLength(data),
  }));
});
`,
    );
    const result = await adapter.runBounded(
      processInput(fixture.root, [script]),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.overflowed, false);
    const payload = JSON.parse(result.stdout.toString("utf8"));
    assert.equal(payload.cwd, fixture.root);
    assert.equal(payload.stdinBytes, 0);
    assert.deepEqual(
      payload.env,
      expectedChildEnvironment(processInput(fixture.root, ["-v"]).env),
    );
    assert.equal("NEXUS_RUNNER_TEST" in payload.env, false);
  },
);

test(
  "real process adapter bounds overflow and kills the process group",
  { skip: !supported },
  async (t) => {
    const fixture = await safeFixture(t);
    const adapter = createEngineProcessAdapter();
    const pidFile = join(fixture.root, "overflow-child.pid");
    const script = await writeScript(
      fixture,
      "overflow-process.mjs",
      `import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
  { stdio: "ignore" },
);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.on("SIGTERM", () => {});
process.stdout.write("x".repeat(20_000));
setInterval(() => {}, 1_000);
`,
    );
    const result = await adapter.runBounded(
      processInput(fixture.root, [script]),
    );
    assert.equal(result.overflowed, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout.byteLength, 16 * 1_024);
    await assertProcessGone(Number(await readFile(pidFile, "utf8")));
  },
);

test(
  "a cooperative overflow process settles before the TERM grace limit",
  { skip: !supported },
  async (t) => {
    const fixture = await safeFixture(t);
    const adapter = createEngineProcessAdapter();
    const script = await writeScript(
      fixture,
      "cooperative-process.mjs",
      `process.on("SIGTERM", () => process.exit(0));
process.stdout.write("x".repeat(20_000));
setInterval(() => {}, 1_000);
`,
    );
    const startedAt = Date.now();
    const result = await adapter.runBounded(
      processInput(fixture.root, [script]),
    );
    assert.equal(result.overflowed, true);
    assert.equal(result.timedOut, false);
    assert.equal(Date.now() - startedAt < 1_500, true);
  },
);

test(
  "real process adapter times out and kills the process group",
  { skip: !supported },
  async (t) => {
    const fixture = await safeFixture(t);
    const adapter = createEngineProcessAdapter();
    const pidFile = join(fixture.root, "timeout-child.pid");
    const script = await writeScript(
      fixture,
      "timeout-process.mjs",
      `import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
  { stdio: "ignore" },
);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
    );
    const result = await adapter.runBounded(
      processInput(fixture.root, [script]),
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.overflowed, false);
    await assertProcessGone(Number(await readFile(pidFile, "utf8")));
  },
);

test("real effect code is isolated from the pure probe module", async () => {
  const [adapterSource, coreSource] = await Promise.all([
    readFile(
      new URL("../runner/engine-adapters.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../runner/engine-probes.mjs", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(adapterSource, /node:child_process/u);
  assert.match(adapterSource, /O_NOFOLLOW/u);
  assert.match(adapterSource, /O_NONBLOCK/u);
  assert.doesNotMatch(coreSource, /node:child_process|node:fs/u);
});

async function safeFixture(t) {
  const root = await mkdtemp(join(process.cwd(), ".engine-adapter-test-"));
  await chmod(root, 0o700);
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { bin, root };
}

async function writeScript(fixture, name, source) {
  const path = join(fixture.bin, name);
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

function effectiveIdentity() {
  return {
    egid: process.getegid(),
    euid: process.geteuid(),
    groups: process.getgroups(),
    platform: process.platform,
  };
}

function processInput(cwd, argv) {
  return {
    argv,
    cwd,
    env: {
      HOME: cwd,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      TERM: "dumb",
      TMPDIR: cwd,
    },
    executableRealPath: process.execPath,
    maxStderrBytes: 16 * 1_024,
    maxStdoutBytes: 16 * 1_024,
    timeoutMs: 5_000,
  };
}

function expectedChildEnvironment(literalEnvironment) {
  if (process.platform !== "darwin") return literalEnvironment;
  return {
    ...literalEnvironment,
    __CF_USER_TEXT_ENCODING:
      `0x${process.geteuid().toString(16).toUpperCase()}:0x0:0x0`,
  };
}

async function assertProcessGone(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} survived the adapter cleanup`);
}
