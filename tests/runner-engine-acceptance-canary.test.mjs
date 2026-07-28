import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runEngineAcceptanceCanary,
} from "../runner/engine-acceptance-canary.mjs";
import {
  createEngineLaunchRecipe,
} from "../runner/engine-launch-recipe.mjs";
import {
  ENGINE_METADATA_SPECS,
} from "../runner/engine-probes.mjs";

const SENTINEL = "NEXUS_CANARY_TOOLS_DISABLED_V1";
const fingerprintFacts = Object.freeze({
  dev: "1",
  ino: "2",
  mode: 0o100700,
  mtimeMs: 1,
  size: 1,
  uid: 501,
});

test("canary contract uses each literal recipe and leaves no evidence", async (t) => {
  const fixture = await canaryFixture(t);
  for (const engine of ["claude_code_cli", "codex_cli"]) {
    let captured;
    const result = await runEngineAcceptanceCanary(
      fixture.input(engine),
      {
        async runBounded(input, hooks) {
          captured = {
            ...input,
            argv: [...input.argv],
            env: { ...input.env },
            prompt: Buffer.from(input.stdin),
          };
          const names = await readdir(input.cwd);
          assert.equal(names.length, 1);
          const marker = join(input.cwd, names[0]);
          const metadata = await lstat(marker);
          assert.equal(metadata.mode & 0o777, 0o600);
          assert.match(
            captured.prompt.toString("utf8"),
            /file-reading tool/u,
          );
          assert.match(
            captured.prompt.toString("utf8"),
            /shell tool/u,
          );
          await hooks.beforeInput({
            childPid: 123,
            startedAt: "2026-07-28T12:00:00.000Z",
          });
          return successfulOutcome(engine);
        },
      },
    );
    assert.deepEqual(result, { kind: "ready" });
    const expected = createEngineLaunchRecipe({
      engine,
      engineVersion:
        ENGINE_METADATA_SPECS[engine].supportedVersions[0],
      executableRealPath: fixture.executableRealPath,
      home: fixture.home,
      scratch: captured.cwd,
    });
    assert.deepEqual(captured.argv, expected.argv);
    assert.deepEqual(captured.env, expected.env);
    assert.equal(captured.cwd, expected.cwd);
    assert.equal(captured.prompt.includes(SENTINEL), true);
    assert.deepEqual(await readdir(fixture.scratchRoot), []);
  }
});

test("canary fails closed when the marker secret is disclosed", async (t) => {
  const fixture = await canaryFixture(t);
  const result = await runEngineAcceptanceCanary(
    fixture.input("claude_code_cli"),
    {
      async runBounded(input) {
        const [markerName] = await readdir(input.cwd);
        const secret = await readFile(join(input.cwd, markerName));
        return outcome({ stdout: secret });
      },
    },
  );
  assert.deepEqual(result, { kind: "not_ready" });
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
});

test("canary fails closed on any filesystem side effect", async (t) => {
  const fixture = await canaryFixture(t);
  for (const mutate of [
    async (input) => {
      await writeFile(join(input.cwd, "unexpected-side-effect"), "x");
    },
    async (input) => {
      const [markerName] = await readdir(input.cwd);
      await writeFile(join(input.cwd, markerName), "mutated");
    },
  ]) {
    const result = await runEngineAcceptanceCanary(
      fixture.input("claude_code_cli"),
      {
        async runBounded(input) {
          await mutate(input);
          return successfulOutcome("claude_code_cli");
        },
      },
    );
    assert.deepEqual(result, { kind: "not_ready" });
  }
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
});

test("engine-specific parsers reject tool and event-like output", async (t) => {
  const fixture = await canaryFixture(t);
  const cases = [
    {
      engine: "claude_code_cli",
      stdout: Buffer.from(
        '{"type":"tool_use","name":"Read"}\n',
        "utf8",
      ),
    },
    {
      engine: "codex_cli",
      stdout: codexJsonLines([
        { type: "thread.started", thread_id: "thread_1" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "true",
          },
        },
        { type: "turn.completed", usage: {} },
      ]),
    },
  ];
  for (const value of cases) {
    const result = await runEngineAcceptanceCanary(
      fixture.input(value.engine),
      {
        async runBounded() {
          return outcome({ stdout: value.stdout });
        },
      },
    );
    assert.deepEqual(result, { kind: "not_ready" });
  }
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
});

test("nonzero, timeout and overflow all fail closed", async (t) => {
  const fixture = await canaryFixture(t);
  for (const override of [
    { exitCode: 1 },
    { exitCode: null, timedOut: true },
    { exitCode: null, overflowed: true },
  ]) {
    const result = await runEngineAcceptanceCanary(
      fixture.input("claude_code_cli"),
      {
        async runBounded() {
          return outcome({
            stdout: Buffer.from(`${SENTINEL}\n`, "utf8"),
            ...override,
          });
        },
      },
    );
    assert.deepEqual(result, { kind: "not_ready" });
  }
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
});

test("canary forwards cancellation to the bounded provider process", async (t) => {
  const fixture = await canaryFixture(t);
  const controller = new AbortController();
  const pending = runEngineAcceptanceCanary(
    {
      ...fixture.input("claude_code_cli"),
      signal: controller.signal,
    },
    {
      async runBounded(input) {
        assert.equal(input.signal, controller.signal);
        if (!input.signal.aborted) {
          await new Promise((resolveAbort) =>
            input.signal.addEventListener("abort", resolveAbort, {
              once: true,
            })
          );
        }
        return outcome({ canceled: true });
      },
    },
  );
  controller.abort("serve_stopped");
  assert.deepEqual(await pending, { kind: "not_ready" });
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
});

function successfulOutcome(engine) {
  return outcome({
    stdout: engine === "claude_code_cli"
      ? Buffer.from(`${SENTINEL}\n`, "utf8")
      : codexJsonLines([
          { type: "thread.started", thread_id: "thread_1" },
          { type: "turn.started" },
          {
            type: "item.completed",
            item: {
              id: "item_1",
              type: "agent_message",
              text: SENTINEL,
            },
          },
          {
            type: "turn.completed",
            usage: {
              cached_input_tokens: 0,
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        ]),
  });
}

function outcome(overrides = {}) {
  return {
    canceled: false,
    exitCode: 0,
    overflowed: false,
    startedAt: "2026-07-28T12:00:00.000Z",
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
    timedOut: false,
    ...overrides,
  };
}

function codexJsonLines(events) {
  return Buffer.from(
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

async function canaryFixture(t) {
  const created = await mkdtemp(
    join(tmpdir(), "nexus-acceptance-test-"),
  );
  const scratchRoot = await realpath(created);
  await chmod(scratchRoot, 0o700);
  t.after(() => rm(scratchRoot, { force: true, recursive: true }));
  const executableRealPath = "/private/nexus/bin/engine";
  const home = scratchRoot;
  return {
    executableRealPath,
    home,
    scratchRoot,
    input(engine) {
      return {
        engine,
        engineVersion:
          ENGINE_METADATA_SPECS[engine].supportedVersions[0],
        executableRealPath,
        fingerprintFacts,
        home,
        scratchRoot,
        timeoutMs: 5_000,
      };
    },
  };
}
