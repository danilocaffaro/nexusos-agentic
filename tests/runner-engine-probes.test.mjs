import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildEngineReport,
  collectEngineInventory,
  ENGINE_CONFIG_MAX_BYTES,
  ENGINE_METADATA_SPECS,
  ENGINE_PROBE_STREAM_MAX_BYTES,
  ENGINE_PROBE_TIMEOUT_MS,
  parseEngineConfiguration,
  validateEngineBinary,
} from "../runner/engine-probes.mjs";
import {
  parseEngineReportBody,
} from "../runner/engine-report-contract.mjs";

const collectedAt = "2026-07-26T12:00:00.000Z";
const identity = {
  egid: 20,
  euid: 501,
  groups: [20, 80],
  platform: "darwin",
};
const configText =
  '{"engines":{"claude_code_cli":{"executablePath":"/Applications/Claude/claude"},"codex_cli":{"executablePath":"/opt/homebrew/bin/codex"}},"schemaVersion":1}';

test("engine configuration is canonical, local-only and closed", () => {
  const configuration = parseEngineConfiguration(`${configText}\n`);
  assert.equal(configuration.schemaVersion, 1);
  assert.equal(
    configuration.engines.claude_code_cli.executablePath,
    "/Applications/Claude/claude",
  );
  assert.deepEqual(
    parseEngineConfiguration('{"engines":{},"schemaVersion":1}').engines,
    {},
  );
  for (const invalid of [
    '{"engines":{"open_code":{"executablePath":"/bin/tool"}},"schemaVersion":1}',
    '{"engines":{"codex_cli":{"executablePath":"codex"}},"schemaVersion":1}',
    '{"engines":{"codex_cli":{"executablePath":"/opt/../bin/codex"}},"schemaVersion":1}',
    '{"engines":{"codex_cli":{"executablePath":"/opt//bin/codex"}},"schemaVersion":1}',
    '{"engines":{},"schemaVersion":1,"home":"/Users/operator"}',
    '{ "engines": {}, "schemaVersion": 1 }',
  ]) {
    assert.throws(
      () => parseEngineConfiguration(invalid),
      /Engine configuration is invalid/u,
    );
  }
  assert.throws(
    () => parseEngineConfiguration("x".repeat(ENGINE_CONFIG_MAX_BYTES + 1)),
    /Engine configuration is invalid/u,
  );
  assert.throws(
    () =>
      parseEngineConfiguration(
        Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(configText)]),
      ),
    /Engine configuration is invalid/u,
  );
});

test("binary validation binds safe realpath facts to an open inode", async () => {
  const filesystem = fakeFilesystem();
  filesystem.target.dev = "-1";
  filesystem.openFacts.dev = "-1";
  filesystem.target.mtimeMs = 1000.25;
  filesystem.openFacts.mtimeMs = 1000.25;
  const valid = await validateEngineBinary(
    {
      configuredPath: "/opt/homebrew/bin/codex",
      ...identity,
    },
    filesystem,
  );
  assert.equal(valid.kind, "valid");
  assert.equal(valid.realPath, "/opt/homebrew/Cellar/codex/0.145/bin/codex");
  assert.deepEqual(valid.fingerprintFacts, {
    dev: "-1",
    ino: "50",
    mode: 0o100755,
    mtimeMs: 1000.25,
    size: 1234,
    uid: 501,
  });
  assert.deepEqual(filesystem.opened, [
    "/opt/homebrew/Cellar/codex/0.145/bin/codex",
  ]);
  assert.equal(filesystem.closed, 1);
});

test("unsafe owner, writes, set-id, components and inode races fail closed", async () => {
  const mutations = [
    (filesystem) => {
      filesystem.target.uid = 777;
    },
    (filesystem) => {
      filesystem.target.mode = 0o100775;
    },
    (filesystem) => {
      filesystem.target.mode = 0o104755;
    },
    (filesystem) => {
      filesystem.directories["/opt/homebrew"].mode = 0o40775;
    },
    (filesystem) => {
      filesystem.directories["/opt/homebrew"].uid = 777;
    },
    (filesystem) => {
      filesystem.openFacts.ino = "51";
    },
    (filesystem) => {
      filesystem.target.kind = "symlink";
    },
  ];
  for (const mutate of mutations) {
    const filesystem = fakeFilesystem();
    mutate(filesystem);
    assert.deepEqual(
      await validateEngineBinary(
        {
          configuredPath: "/opt/homebrew/bin/codex",
          ...identity,
        },
        filesystem,
      ),
      { kind: "invalid" },
    );
  }
  for (const field of ["dev", "ino"]) {
    for (const impreciseIdentity of [50, 50n]) {
      const filesystem = fakeFilesystem();
      filesystem.target[field] = impreciseIdentity;
      filesystem.openFacts[field] = impreciseIdentity;
      assert.deepEqual(
        await validateEngineBinary(
          {
            configuredPath: "/opt/homebrew/bin/codex",
            ...identity,
          },
          filesystem,
        ),
        { kind: "invalid" },
      );
    }
  }
});

test("fake metadata and auth ports produce a full report without retaining raw auth", async () => {
  const configuration = parseEngineConfiguration(configText);
  const filesystem = fakeFilesystem({
    paths: {
      "/Applications/Claude/claude":
        "/Applications/Claude/claude",
      "/opt/homebrew/bin/codex":
        "/opt/homebrew/Cellar/codex/0.145/bin/codex",
    },
  });
  const processPort = fakeProcessPort();
  const snapshot = await collectEngineInventory({
    collectedAt,
    configuration,
    filesystem,
    process: processPort,
    identity,
    home: "/Users/operator",
    locale: "C",
    tmpdir: "/private/tmp",
  });
  assert.deepEqual(
    snapshot.probes.map((probe) => ({
      engine: probe.engine,
      readiness: probe.readiness,
      status: probe.status,
      version: probe.version,
    })),
    [
      {
        engine: "claude_code_cli",
        readiness: "ready",
        status: "available",
        version: "2.1.219 (Claude Code)",
      },
      {
        engine: "codex_cli",
        readiness: "ready",
        status: "available",
        version: "codex-cli 0.145.0",
      },
    ],
  );
  assert.match(snapshot.changeFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(snapshot).includes("operator@example.com"), false);
  assert.equal(JSON.stringify(snapshot).includes("/Users/operator"), false);
  const report = buildEngineReport({
    collectedAt,
    probes: snapshot.probes,
    reportId: `egr_${"4".repeat(32)}`,
    truncated: snapshot.truncated,
  });
  assert.ok(parseEngineReportBody(report));
  assert.throws(
    () =>
      buildEngineReport({
        collectedAt,
        probes: snapshot.probes.map((probe) => ({
          ...probe,
          collectedAt: "2026-07-26T12:00:00.001Z",
        })),
        reportId: `egr_${"4".repeat(32)}`,
        truncated: snapshot.truncated,
      }),
    /Engine report input is invalid/u,
  );

  for (const call of processPort.calls) {
    assert.equal(call.timeoutMs, ENGINE_PROBE_TIMEOUT_MS);
    assert.equal(call.maxStdoutBytes, ENGINE_PROBE_STREAM_MAX_BYTES);
    assert.equal(call.maxStderrBytes, ENGINE_PROBE_STREAM_MAX_BYTES);
    assert.equal(call.env.PATH.endsWith(":/usr/bin:/bin"), true);
    assert.equal("NEXUS_TOKEN" in call.env, false);
    assert.equal(call.env.HOME, "/Users/operator");
    assert.equal(call.env.LANG, "C");
    assert.equal(call.env.LC_ALL, "C");
  }
});

test("indeterminate auth collapses the complete probe to unknown without version", async () => {
  const configuration = parseEngineConfiguration(configText);
  const processPort = fakeProcessPort({
    handle(input) {
      if (input.argv[0] === "auth") {
        return ok('{"loggedIn":');
      }
      if (input.argv[0] === "login") {
        return {
          exitCode: null,
          timedOut: true,
          overflowed: false,
          stdout: bytes("operator@example.com"),
          stderr: new Uint8Array(),
        };
      }
    },
  });
  const snapshot = await collectEngineInventory({
    collectedAt,
    configuration,
    filesystem: fakeFilesystem({
      paths: {
        "/Applications/Claude/claude":
          "/Applications/Claude/claude",
        "/opt/homebrew/bin/codex":
          "/opt/homebrew/Cellar/codex/0.145/bin/codex",
      },
    }),
    process: processPort,
    identity,
    home: "/Users/operator",
    locale: "C",
    tmpdir: "/private/tmp",
  });
  for (const probe of snapshot.probes) {
    assert.deepEqual(probe, {
      collectedAt,
      engine: probe.engine,
      readiness: "unknown",
      reason: "engine_probe_failed",
      status: "unknown",
    });
  }
  assert.equal(JSON.stringify(snapshot).includes("operator@example.com"), false);
});

test("missing flags, unsupported versions and absent config fail closed per engine", async () => {
  const configuration = parseEngineConfiguration(
    '{"engines":{"codex_cli":{"executablePath":"/opt/homebrew/bin/codex"}},"schemaVersion":1}',
  );
  const processPort = fakeProcessPort({
    helpOverride: bytes("--strict-config only"),
  });
  const snapshot = await collectEngineInventory({
    collectedAt,
    configuration,
    filesystem: fakeFilesystem(),
    process: processPort,
    identity,
    home: "/Users/operator",
    locale: "C",
    tmpdir: "/private/tmp",
  });
  assert.deepEqual(snapshot.probes[0], {
    collectedAt,
    engine: "claude_code_cli",
    readiness: "attention_required",
    reason: "engine_not_configured",
    status: "unavailable",
  });
  assert.deepEqual(snapshot.probes[1], {
    collectedAt,
    engine: "codex_cli",
    readiness: "attention_required",
    reason: "engine_incompatible",
    status: "available",
    version: "codex-cli 0.145.0",
  });
});

test("auth needs positive evidence and explicit Claude logout is attention", async () => {
  const snapshot = await collectEngineInventory({
    collectedAt,
    configuration: parseEngineConfiguration(configText),
    filesystem: fakeFilesystem({
      paths: {
        "/Applications/Claude/claude":
          "/Applications/Claude/claude",
      },
    }),
    process: fakeProcessPort({
      handle(input) {
        if (input.argv[0] === "auth") {
          return ok('{"loggedIn":false,"email":"operator@example.com"}');
        }
        if (input.argv[0] === "login") {
          return ok("Not logged in");
        }
      },
    }),
    identity,
    home: "/Users/operator",
    locale: "C",
    tmpdir: "/private/tmp",
  });
  assert.deepEqual(snapshot.probes[0], {
    collectedAt,
    engine: "claude_code_cli",
    readiness: "attention_required",
    reason: "engine_auth_attention_required",
    status: "available",
    version: "2.1.219 (Claude Code)",
  });
  assert.deepEqual(snapshot.probes[1], {
    collectedAt,
    engine: "codex_cli",
    readiness: "unknown",
    reason: "engine_probe_failed",
    status: "unknown",
  });
  assert.equal(JSON.stringify(snapshot).includes("operator@example.com"), false);

  const codexLoggedOut = await collectEngineInventory({
    collectedAt,
    configuration: parseEngineConfiguration(
      '{"engines":{"codex_cli":{"executablePath":"/opt/homebrew/bin/codex"}},"schemaVersion":1}',
    ),
    filesystem: fakeFilesystem(),
    process: fakeProcessPort({
      handle(input) {
        if (input.argv[0] !== "login") return undefined;
        return {
          ...ok("non-private warning\nNot logged in"),
          exitCode: 1,
        };
      },
    }),
    identity,
    home: "/Users/operator",
    locale: "C",
    tmpdir: "/private/tmp",
  });
  assert.deepEqual(codexLoggedOut.probes[1], {
    collectedAt,
    engine: "codex_cli",
    readiness: "attention_required",
    reason: "engine_auth_attention_required",
    status: "available",
    version: "codex-cli 0.145.0",
  });
});

test("unsupported versions remain visible while malformed versions disappear", async () => {
  const snapshot = await collectEngineInventory({
    collectedAt,
    configuration: parseEngineConfiguration(configText),
    filesystem: fakeFilesystem({
      paths: {
        "/Applications/Claude/claude":
          "/Applications/Claude/claude",
      },
    }),
    process: fakeProcessPort({
      handle(input) {
        if (!input.argv.includes("--version")) return undefined;
        return ok(
          input.executableRealPath.includes("Claude")
            ? "version=/Users/operator/private"
            : "codex-cli 0.146.0",
        );
      },
    }),
    identity,
    home: "/Users/operator",
    locale: "C",
    tmpdir: "/private/tmp",
  });
  assert.deepEqual(snapshot.probes[0], {
    collectedAt,
    engine: "claude_code_cli",
    readiness: "unknown",
    reason: "engine_probe_failed",
    status: "unknown",
  });
  assert.deepEqual(snapshot.probes[1], {
    collectedAt,
    engine: "codex_cli",
    readiness: "attention_required",
    reason: "engine_incompatible",
    status: "available",
    version: "codex-cli 0.146.0",
  });
  assert.equal(JSON.stringify(snapshot).includes("/Users/operator/private"), false);
});

test("binary invalid and overflow branches remain closed and truncated", async () => {
  const configuration = parseEngineConfiguration(
    '{"engines":{"codex_cli":{"executablePath":"/opt/homebrew/bin/codex"}},"schemaVersion":1}',
  );
  const unsafeFilesystem = fakeFilesystem();
  unsafeFilesystem.target.mode = 0o100777;
  unsafeFilesystem.openFacts.mode = 0o100777;
  const invalid = await collectEngineInventory({
    collectedAt,
    configuration,
    filesystem: unsafeFilesystem,
    process: fakeProcessPort(),
    identity,
    home: "/Users/operator",
    locale: "C",
    tmpdir: "/private/tmp",
  });
  assert.deepEqual(invalid.probes[1], {
    collectedAt,
    engine: "codex_cli",
    readiness: "attention_required",
    reason: "engine_binary_invalid",
    status: "unavailable",
  });

  const overflowed = await collectEngineInventory({
    collectedAt,
    configuration,
    filesystem: fakeFilesystem(),
    process: fakeProcessPort({
      handle(input) {
        if (input.argv[0] === "exec") {
          return {
            ...ok("partial"),
            overflowed: true,
          };
        }
      },
    }),
    identity,
    home: "/Users/operator",
    locale: "C",
    tmpdir: "/private/tmp",
  });
  assert.equal(overflowed.truncated, true);
  assert.deepEqual(overflowed.probes[1], {
    collectedAt,
    engine: "codex_cli",
    readiness: "unknown",
    reason: "engine_probe_failed",
    status: "unknown",
  });
});

test("probe specs are frozen, literal and the module has no real effect adapter", async () => {
  assert.equal(Object.isFrozen(ENGINE_METADATA_SPECS), true);
  assert.deepEqual(
    ENGINE_METADATA_SPECS.claude_code_cli.authArgv,
    ["auth", "status", "--json"],
  );
  assert.deepEqual(
    ENGINE_METADATA_SPECS.codex_cli.authArgv,
    ["login", "status"],
  );
  const source = await readFile(
    new URL("../runner/engine-probes.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /node:child_process|node:fs|spawn\s*\(|exec(?:File|Sync)?\s*\(/u,
  );
});

function fakeFilesystem(options = {}) {
  const target = facts({
    kind: "file",
    mode: 0o100755,
    uid: 501,
    gid: 20,
    ino: "50",
    size: 1234,
  });
  const openFacts = { ...target };
  const directories = Object.fromEntries(
    [
      "/",
      "/Applications",
      "/Applications/Claude",
      "/opt",
      "/opt/homebrew",
      "/opt/homebrew/Cellar",
      "/opt/homebrew/Cellar/codex",
      "/opt/homebrew/Cellar/codex/0.145",
      "/opt/homebrew/Cellar/codex/0.145/bin",
    ].map((path) => [
      path,
      facts({
        kind: "directory",
        mode: 0o40755,
        uid: path.startsWith("/Applications/Claude") ? 501 : 0,
        gid: 0,
        ino: String(path.length + 1),
        size: 64,
      }),
    ]),
  );
  const paths = {
    "/opt/homebrew/bin/codex":
      "/opt/homebrew/Cellar/codex/0.145/bin/codex",
    ...options.paths,
  };
  return {
    target,
    openFacts,
    directories,
    opened: [],
    closed: 0,
    async realpath(path) {
      if (!paths[path]) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return paths[path];
    },
    async lstat(path) {
      if (directories[path]) return directories[path];
      if (Object.values(paths).includes(path)) return target;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async openNoFollow(path) {
      this.opened.push(path);
      return {
        facts: openFacts,
        close: async () => {
          this.closed += 1;
        },
      };
    },
  };
}

function fakeProcessPort(options = {}) {
  return {
    calls: [],
    async runBounded(input) {
      this.calls.push(input);
      const handled = options.handle?.(input);
      if (handled !== undefined) return handled;
      const auth = input.argv[0] === "auth" || input.argv[0] === "login";
      if (auth) {
        return ok(
          input.argv[0] === "auth"
            ? '{"loggedIn":true,"email":"operator@example.com"}'
            : "Logged in using ChatGPT",
        );
      }
      if (input.argv.includes("--version")) {
        return ok(
          input.executableRealPath.includes("Claude")
            ? "2.1.219 (Claude Code)\n"
            : "codex-cli 0.145.0\n",
        );
      }
      if (input.argv[0] === "features") {
        return ok(
          ENGINE_METADATA_SPECS.codex_cli.featureTokens.join("\n"),
        );
      }
      if (options.helpOverride) return ok(options.helpOverride);
      const spec = input.executableRealPath.includes("Claude")
        ? ENGINE_METADATA_SPECS.claude_code_cli
        : ENGINE_METADATA_SPECS.codex_cli;
      return ok(spec.helpTokens.join("\n"));
    },
  };
}

function ok(value) {
  return {
    exitCode: 0,
    timedOut: false,
    overflowed: false,
    stdout: value instanceof Uint8Array ? value : bytes(value),
    stderr: new Uint8Array(),
  };
}

function bytes(value) {
  return new TextEncoder().encode(value);
}

function facts(overrides) {
  return {
    dev: "1",
    gid: 0,
    ino: "1",
    kind: "other",
    mode: 0,
    mtimeMs: 1000,
    size: 0,
    uid: 0,
    ...overrides,
  };
}
