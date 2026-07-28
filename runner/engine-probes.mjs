import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  ENGINE_NAMES,
  encodeEngineReport,
} from "./engine-report-contract.mjs";
import {
  normalizeEngineExecutableFingerprint,
  sameEngineExecutableFingerprint,
} from "./engine-executable-identity.mjs";

export const ENGINE_CONFIG_MAX_BYTES = 4_096;
export const ENGINE_PATH_MAX_BYTES = 1_024;
export const ENGINE_PROBE_TIMEOUT_MS = 5_000;
export const ENGINE_PROBE_STREAM_MAX_BYTES = 16 * 1_024;

export const ENGINE_METADATA_SPECS = deepFreeze({
  claude_code_cli: {
    versionArgv: ["--version"],
    helpArgv: ["--help"],
    authArgv: ["auth", "status", "--json"],
    supportedVersions: [
      "2.1.219 (Claude Code)",
      "2.1.220 (Claude Code)",
    ],
    helpTokens: [
      "--print",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--permission-mode",
      "--tools",
      "--strict-mcp-config",
      "--mcp-config",
      "--settings",
      "--output-format",
    ],
  },
  codex_cli: {
    versionArgv: ["--version"],
    helpArgv: ["exec", "--help"],
    featureArgv: ["features", "list"],
    authArgv: ["login", "status"],
    supportedVersions: [
      "codex-cli 0.146.0-alpha.3.1",
    ],
    helpTokens: [
      "--strict-config",
      "--sandbox",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--color",
      "--json",
      "--disable",
      "--config",
    ],
    featureTokens: [
      "apps",
      "goals",
      "hooks",
      "multi_agent",
      "remote_plugin",
      "shell_snapshot",
      "shell_tool",
    ],
  },
});

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,63}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_ERROR_CODES = new Set([
  "EACCES",
  "EIO",
  "ENOENT",
  "ENOTDIR",
]);

export function parseEngineConfiguration(input) {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    throw new TypeError("Engine configuration is invalid.");
  }
  const raw = typeof input === "string"
    ? Buffer.from(input, "utf8")
    : Buffer.from(input);
  if (raw.byteLength < 1 || raw.byteLength > ENGINE_CONFIG_MAX_BYTES) {
    throw new TypeError("Engine configuration is invalid.");
  }
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(raw);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("Engine configuration is invalid.");
  }
  if (
    !plainRecord(parsed) ||
    !hasExactKeys(parsed, ["engines", "schemaVersion"]) ||
    parsed.schemaVersion !== 1 ||
    !plainRecord(parsed.engines) ||
    !Object.keys(parsed.engines).every((engine) =>
      ENGINE_NAMES.includes(engine),
    )
  ) {
    throw new TypeError("Engine configuration is invalid.");
  }
  for (const value of Object.values(parsed.engines)) {
    if (
      !plainRecord(value) ||
      !hasExactKeys(value, ["executablePath"]) ||
      !safeAbsolutePath(value.executablePath)
    ) {
      throw new TypeError("Engine configuration is invalid.");
    }
  }
  if (canonicalJson(parsed) !== text) {
    throw new TypeError("Engine configuration is invalid.");
  }
  return parsed;
}

export function encodeEngineConfiguration(configuration) {
  let text;
  try {
    text = canonicalJson(configuration);
  } catch {
    throw new TypeError("Engine configuration is invalid.");
  }
  if (typeof text !== "string") {
    throw new TypeError("Engine configuration is invalid.");
  }
  parseEngineConfiguration(text);
  return `${text}\n`;
}

export async function validateEngineBinary(input, filesystem) {
  if (
    !input ||
    !safeAbsolutePath(input.configuredPath) ||
    !["darwin", "linux"].includes(input.platform) ||
    !safeIdentity(input) ||
    !validFilesystemPort(filesystem)
  ) {
    return { kind: "invalid" };
  }
  let handle;
  try {
    const realPath = await filesystem.realpath(input.configuredPath);
    if (!safeAbsolutePath(realPath)) return { kind: "invalid" };
    const target = await filesystem.lstat(realPath);
    if (!safeTarget(target, input)) return { kind: "invalid" };
    for (const directory of parentDirectories(realPath)) {
      if (!safeDirectory(await filesystem.lstat(directory), input)) {
        return { kind: "invalid" };
      }
    }
    handle = await filesystem.openNoFollow(realPath);
    if (
      !handle ||
      typeof handle.close !== "function" ||
      !sameTarget(target, handle.facts) ||
      !safeTarget(handle.facts, input)
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "valid",
      realPath,
      fingerprintFacts: {
        dev: target.dev,
        ino: target.ino,
        mode: target.mode,
        mtimeMs: target.mtimeMs,
        size: target.size,
        uid: target.uid,
      },
    };
  } catch {
    return { kind: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validateEngineProbeDirectory(input, filesystem) {
  if (
    !input ||
    !safeAbsolutePath(input.path) ||
    !safeIdentity(input) ||
    !validFilesystemPort(filesystem)
  ) {
    return { kind: "invalid" };
  }
  try {
    const realPath = await filesystem.realpath(input.path);
    if (!safeAbsolutePath(realPath)) return { kind: "invalid" };
    const target = await filesystem.lstat(realPath);
    if (
      !validFacts(target) ||
      target.kind !== "directory" ||
      target.uid !== input.euid ||
      (target.mode & 0o777) !== 0o700
    ) {
      return { kind: "invalid" };
    }
    for (const directory of parentDirectories(realPath)) {
      if (!safeDirectory(await filesystem.lstat(directory), input)) {
        return { kind: "invalid" };
      }
    }
    return { kind: "valid", realPath };
  } catch {
    return { kind: "invalid" };
  }
}

export async function collectEngineInventory(input) {
  if (
    !input ||
    !validParsedConfiguration(input.configuration) ||
    !validFilesystemPort(input.filesystem) ||
    !validProcessPort(input.process) ||
    !canonicalTimestamp(input.collectedAt) ||
    !safeIdentity(input.identity) ||
    !safeAbsolutePath(input.home) ||
    !safeAbsolutePath(input.tmpdir) ||
    !["C", "C.UTF-8"].includes(input.locale)
  ) {
    throw new TypeError("Engine probe configuration is invalid.");
  }
  const probes = [];
  const fingerprint = [];
  let truncated = false;
  for (const engine of ENGINE_NAMES) {
    const result = await probeOne({
      engine,
      configured: input.configuration.engines?.[engine],
      collectedAt: input.collectedAt,
      filesystem: input.filesystem,
      processPort: input.process,
      identity: input.identity,
      home: input.home,
      tmpdir: input.tmpdir,
      locale: input.locale,
    });
    probes.push(result.probe);
    fingerprint.push(result.fingerprint);
    truncated ||= result.truncated;
  }
  return {
    probes,
    truncated,
    changeFingerprint: createHash("sha256")
      .update(canonicalJson(fingerprint))
      .digest("hex"),
  };
}

export async function resolveEngineExecutionReady(input) {
  if (
    !plainRecord(input) ||
    !hasExactKeys(input, [
      "configuration",
      "engine",
      "expectedVersion",
      "filesystem",
      "home",
      "identity",
      "locale",
      "process",
      "tmpdir",
    ]) ||
    !validParsedConfiguration(input.configuration) ||
    !ENGINE_NAMES.includes(input.engine) ||
    typeof input.expectedVersion !== "string" ||
    !VERSION_PATTERN.test(input.expectedVersion) ||
    !validFilesystemPort(input.filesystem) ||
    !validProcessPort(input.process) ||
    !safeIdentity(input.identity) ||
    !safeAbsolutePath(input.home) ||
    !safeAbsolutePath(input.tmpdir) ||
    !["C", "C.UTF-8"].includes(input.locale)
  ) {
    throw new TypeError("Engine execution readiness input is invalid.");
  }
  const configured = input.configuration.engines[input.engine];
  if (!configured) return notReady("engine_not_configured");
  const before = await validateEngineBinary(
    {
      configuredPath: configured.executablePath,
      ...input.identity,
    },
    input.filesystem,
  );
  if (before.kind !== "valid") {
    return notReady("engine_binary_invalid");
  }

  const spec = ENGINE_METADATA_SPECS[input.engine];
  const base = {
    cwd: input.tmpdir,
    executableRealPath: before.realPath,
    maxStderrBytes: ENGINE_PROBE_STREAM_MAX_BYTES,
    maxStdoutBytes: ENGINE_PROBE_STREAM_MAX_BYTES,
    timeoutMs: ENGINE_PROBE_TIMEOUT_MS,
  };
  const env = probeEnvironment(
    before.realPath,
    input.tmpdir,
    input.home,
    input.locale,
  );
  const metadata = [];
  for (const argv of [
    spec.versionArgv,
    spec.helpArgv,
    ...(spec.featureArgv ? [spec.featureArgv] : []),
  ]) {
    metadata.push(
      await safeRun(input.process, {
        ...base,
        argv,
        env,
      }),
    );
  }
  if (metadata.some((outcome) => !successfulProbe(outcome))) {
    return notReady("engine_probe_failed");
  }
  const version = parseVersion(input.engine, metadata[0]);
  if (
    version !== input.expectedVersion ||
    !spec.supportedVersions.includes(version) ||
    !containsEvery(probeText(metadata[1]), spec.helpTokens) ||
    (
      spec.featureTokens &&
      !containsEvery(probeText(metadata[2]), spec.featureTokens)
    )
  ) {
    return notReady("engine_incompatible");
  }
  const auth = await safeRun(input.process, {
    ...base,
    argv: spec.authArgv,
    env,
  });
  const authState = parseAuthState(input.engine, auth);
  if (authState === "unknown") {
    return notReady("engine_probe_failed");
  }
  if (authState !== "ready") {
    return notReady("engine_auth_attention_required");
  }

  const after = await validateEngineBinary(
    {
      configuredPath: configured.executablePath,
      ...input.identity,
    },
    input.filesystem,
  );
  if (
    after.kind !== "valid" ||
    after.realPath !== before.realPath ||
    !sameEngineExecutableFingerprint(
      after.fingerprintFacts,
      before.fingerprintFacts,
    )
  ) {
    return notReady("engine_binary_changed");
  }
  return deepFreeze({
    engine: input.engine,
    engineVersion: version,
    executableRealPath: after.realPath,
    fingerprintFacts:
      normalizeEngineExecutableFingerprint(after.fingerprintFacts),
    kind: "ready",
  });
}

export function buildEngineReport(input) {
  if (
    !input ||
    !/^egr_[0-9a-f]{32}$/u.test(input.reportId ?? "") ||
    !canonicalTimestamp(input.collectedAt) ||
    !Array.isArray(input.probes) ||
    input.probes.length !== ENGINE_NAMES.length ||
    !input.probes.every(
      (probe) => probe?.collectedAt === input.collectedAt,
    ) ||
    typeof input.truncated !== "boolean"
  ) {
    throw new TypeError("Engine report input is invalid.");
  }
  return encodeEngineReport({
    collectedAt: input.collectedAt,
    engines: input.probes.map((probe) => {
      const { collectedAt: ignored, ...evidence } = probe;
      void ignored;
      return evidence;
    }),
    reportId: input.reportId,
    schemaVersion: 1,
    truncated: input.truncated,
  });
}

function notReady(reason) {
  return deepFreeze({ kind: "not_ready", reason });
}

async function probeOne(input) {
  if (!input.configured) {
    return closedProbe(
      input,
      "unavailable",
      "attention_required",
      "engine_not_configured",
      false,
      { configured: false },
    );
  }
  const binary = await validateEngineBinary(
    {
      configuredPath: input.configured.executablePath,
      ...input.identity,
    },
    input.filesystem,
  );
  if (binary.kind !== "valid") {
    return closedProbe(
      input,
      "unavailable",
      "attention_required",
      "engine_binary_invalid",
      false,
      { configured: true, valid: false },
    );
  }

  const spec = ENGINE_METADATA_SPECS[input.engine];
  const base = {
    cwd: input.tmpdir,
    executableRealPath: binary.realPath,
    maxStderrBytes: ENGINE_PROBE_STREAM_MAX_BYTES,
    maxStdoutBytes: ENGINE_PROBE_STREAM_MAX_BYTES,
    timeoutMs: ENGINE_PROBE_TIMEOUT_MS,
  };
  const metadataEnv = probeEnvironment(
    binary.realPath,
    input.tmpdir,
    input.home,
    input.locale,
  );
  const outcomes = [];
  for (const argv of [
    spec.versionArgv,
    spec.helpArgv,
    ...(spec.featureArgv ? [spec.featureArgv] : []),
  ]) {
    outcomes.push(
      await safeRun(input.processPort, {
        ...base,
        argv,
        env: metadataEnv,
      }),
    );
  }
  const wasTruncated = outcomes.some((outcome) => outcome.overflowed);
  if (outcomes.some((outcome) => !successfulProbe(outcome))) {
    return closedProbe(
      input,
      "unknown",
      "unknown",
      "engine_probe_failed",
      wasTruncated,
      {
        binary: binary.fingerprintFacts,
        metadata: outcomes.map(closedOutcome),
        realPath: binary.realPath,
      },
    );
  }
  const version = parseVersion(input.engine, outcomes[0]);
  if (!version) {
    return closedProbe(
      input,
      "unknown",
      "unknown",
      "engine_probe_failed",
      wasTruncated,
      {
        binary: binary.fingerprintFacts,
        metadata: outcomes.map(closedOutcome),
        realPath: binary.realPath,
      },
    );
  }
  const compatible =
    spec.supportedVersions.includes(version) &&
    containsEvery(probeText(outcomes[1]), spec.helpTokens) &&
    (!spec.featureTokens ||
      containsEvery(probeText(outcomes[2]), spec.featureTokens));
  if (!compatible) {
    return closedProbe(
      input,
      "available",
      "attention_required",
      "engine_incompatible",
      wasTruncated,
      {
        binary: binary.fingerprintFacts,
        metadata: outcomes.map(closedOutcome),
        realPath: binary.realPath,
        version,
      },
      version,
    );
  }

  const auth = await safeRun(input.processPort, {
    ...base,
    argv: spec.authArgv,
    env: metadataEnv,
  });
  const authState = parseAuthState(input.engine, auth);
  if (authState === "unknown") {
    return closedProbe(
      input,
      "unknown",
      "unknown",
      "engine_probe_failed",
      auth.overflowed,
      {
        auth: closedOutcome(auth),
        binary: binary.fingerprintFacts,
        realPath: binary.realPath,
      },
    );
  }
  if (authState === "attention_required") {
    return closedProbe(
      input,
      "available",
      "attention_required",
      "engine_auth_attention_required",
      auth.overflowed,
      {
        auth: closedOutcome(auth),
        binary: binary.fingerprintFacts,
        realPath: binary.realPath,
        version,
      },
      version,
    );
  }
  return closedProbe(
    input,
    "available",
    "ready",
    "none",
    auth.overflowed,
    {
      auth: closedOutcome(auth),
      binary: binary.fingerprintFacts,
      realPath: binary.realPath,
      version,
    },
    version,
  );
}

function closedProbe(
  input,
  status,
  readiness,
  reason,
  truncated,
  fingerprint,
  version,
) {
  const declaration = {
    engine: input.engine,
    readiness,
    reason,
    status,
    ...(version ? { version } : {}),
  };
  return {
    probe: { collectedAt: input.collectedAt, ...declaration },
    truncated,
    fingerprint: { declaration, ...fingerprint },
  };
}

function parseVersion(engine, outcome) {
  const text = probeText(outcome);
  if (text === undefined) return undefined;
  const value = text.trim();
  if (!VERSION_PATTERN.test(value)) return undefined;
  if (
    engine === "claude_code_cli" &&
    !/^\d{1,3}\.\d{1,3}\.\d{1,3} \(Claude Code\)$/u.test(value)
  ) {
    return undefined;
  }
  if (
    engine === "codex_cli" &&
    !/^codex-cli \d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/u.test(
      value,
    )
  ) {
    return undefined;
  }
  return value;
}

function parseAuthState(engine, outcome) {
  if (
    outcome.errorCode ||
    outcome.timedOut ||
    outcome.overflowed ||
    !Number.isInteger(outcome.exitCode)
  ) {
    return "unknown";
  }
  const text = probeText(outcome);
  if (text === undefined) return "unknown";
  if (engine === "claude_code_cli") {
    try {
      const value = JSON.parse(text);
      if (!plainRecord(value) || typeof value.loggedIn !== "boolean") {
        return "unknown";
      }
      return value.loggedIn ? "ready" : "attention_required";
    } catch {
      return "unknown";
    }
  }
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    outcome.exitCode === 0 &&
    lines.some((line) =>
      /^Logged in using (?:ChatGPT|an API key)$/u.test(line),
    )
  ) {
    return "ready";
  }
  if (
    outcome.exitCode === 1 &&
    lines.includes("Not logged in")
  ) {
    return "attention_required";
  }
  return "unknown";
}

function probeEnvironment(realPath, tmpdir, home, locale) {
  return Object.freeze({
    HOME: home,
    PATH: `${posix.dirname(realPath)}:/usr/bin:/bin`,
    TMPDIR: tmpdir,
    LANG: locale,
    LC_ALL: locale,
    TERM: "dumb",
    NO_COLOR: "1",
  });
}

async function safeRun(port, input) {
  try {
    const result = await port.runBounded(input);
    return validProcessResult(result)
      ? result
      : failedProcessResult();
  } catch {
    return failedProcessResult();
  }
}

function successfulProbe(outcome) {
  return (
    !outcome.errorCode &&
    outcome.exitCode === 0 &&
    !outcome.timedOut &&
    !outcome.overflowed
  );
}

function probeText(outcome) {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return `${decoder.decode(outcome.stdout)}\n${decoder.decode(outcome.stderr)}`;
  } catch {
    return undefined;
  }
}

function containsEvery(text, tokens) {
  return (
    typeof text === "string" &&
    tokens.every((token) => text.includes(token))
  );
}

function validProcessResult(result) {
  return Boolean(
    plainRecord(result) &&
      (result.exitCode === null || Number.isInteger(result.exitCode)) &&
      (result.exitCode === null ||
        (result.exitCode >= 0 && result.exitCode <= 255)) &&
      typeof result.timedOut === "boolean" &&
      typeof result.overflowed === "boolean" &&
      result.stdout instanceof Uint8Array &&
      result.stderr instanceof Uint8Array &&
      result.stdout.byteLength <= ENGINE_PROBE_STREAM_MAX_BYTES &&
      result.stderr.byteLength <= ENGINE_PROBE_STREAM_MAX_BYTES &&
      (result.errorCode === undefined ||
        SAFE_ERROR_CODES.has(result.errorCode)),
  );
}

function failedProcessResult() {
  return {
    exitCode: null,
    timedOut: false,
    overflowed: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    errorCode: "ENOENT",
  };
}

function closedOutcome(outcome) {
  return {
    errorCode: outcome.errorCode ?? null,
    exitCode: outcome.exitCode,
    overflowed: outcome.overflowed,
    timedOut: outcome.timedOut,
  };
}

function safeTarget(facts, identity) {
  return Boolean(
    validFacts(facts) &&
      facts.kind === "file" &&
      (facts.uid === 0 || facts.uid === identity.euid) &&
      (facts.mode & 0o022) === 0 &&
      (facts.mode & 0o6000) === 0 &&
      executableByIdentity(facts, identity),
  );
}

function safeDirectory(facts, identity) {
  return Boolean(
    validFacts(facts) &&
      facts.kind === "directory" &&
      (facts.uid === 0 || facts.uid === identity.euid) &&
      (facts.mode & 0o022) === 0 &&
      executableByIdentity(facts, identity),
  );
}

function executableByIdentity(facts, identity) {
  if (identity.euid === 0) return (facts.mode & 0o111) !== 0;
  if (facts.uid === identity.euid) return (facts.mode & 0o100) !== 0;
  if (
    facts.gid === identity.egid ||
    identity.groups.includes(facts.gid)
  ) {
    return (facts.mode & 0o010) !== 0;
  }
  return (facts.mode & 0o001) !== 0;
}

function sameTarget(left, right) {
  return (
    validFacts(right) &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function parentDirectories(path) {
  const directories = [];
  let current = posix.dirname(path);
  while (true) {
    directories.unshift(current);
    if (current === "/") return directories;
    current = posix.dirname(current);
  }
}

function safeAbsolutePath(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= ENGINE_PATH_MAX_BYTES &&
    posix.isAbsolute(value) &&
    value !== "/" &&
    !/[\0\r\n]/u.test(value) &&
    !value.includes("//") &&
    !value.split("/").includes(".") &&
    !value.split("/").includes("..")
  );
}

function safeIdentity(input) {
  return Boolean(
    ["darwin", "linux"].includes(input.platform) &&
      Number.isSafeInteger(input.euid) &&
      input.euid >= 0 &&
      Number.isSafeInteger(input.egid) &&
      input.egid >= 0 &&
      Array.isArray(input.groups) &&
      input.groups.every(
        (group) => Number.isSafeInteger(group) && group >= 0,
      ),
  );
}

function validFacts(value) {
  return Boolean(
    plainRecord(value) &&
      ["directory", "file", "other", "symlink"].includes(value.kind) &&
      typeof value.dev === "string" &&
      /^-?(?:0|[1-9][0-9]{0,39})$/u.test(value.dev) &&
      typeof value.ino === "string" &&
      /^(?:0|[1-9][0-9]{0,39})$/u.test(value.ino) &&
      Number.isFinite(value.mtimeMs) &&
      value.mtimeMs >= 0 &&
      ["gid", "mode", "size", "uid"].every(
        (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
      ),
  );
}

function validFilesystemPort(value) {
  return Boolean(
    value &&
      typeof value.realpath === "function" &&
      typeof value.lstat === "function" &&
      typeof value.openNoFollow === "function",
  );
}

function validProcessPort(value) {
  return Boolean(value && typeof value.runBounded === "function");
}

function validParsedConfiguration(value) {
  return Boolean(
    plainRecord(value) &&
      hasExactKeys(value, ["engines", "schemaVersion"]) &&
      value.schemaVersion === 1 &&
      plainRecord(value.engines) &&
      Object.entries(value.engines).every(
        ([engine, configured]) =>
          ENGINE_NAMES.includes(engine) &&
          plainRecord(configured) &&
          hasExactKeys(configured, ["executablePath"]) &&
          safeAbsolutePath(configured.executablePath),
      ),
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  );
}

function plainRecord(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
