#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  acquireOutboxLock,
  generateLocalOperationId,
  operationBody,
  OutboxError,
  persistDeclarationOperation,
  persistOperation,
  pruneOutbox,
  recoverOutbox,
  transitionOperation,
} from "./durable-outbox.mjs";
import {
  CAPABILITY_ORDER,
  collectCapabilityEvidence,
} from "./capability-probes.mjs";
import {
  deriveOutboxPathname,
  isOutboxEntry,
  OUTBOX_V3_DIRECTORY,
  parseOutboxEntryText,
} from "./outbox-contract.mjs";
import {
  classifyEngineCompleteResponse,
  parseEngineCompleteAck,
  parseEngineCompleteBody,
} from "./engine-complete-contract.mjs";
import {
  EngineConfigStoreError,
  readEngineConfiguration,
  writeEngineConfiguration,
} from "./engine-config-store.mjs";
import {
  createEngineCompletionHttpEffect,
} from "./engine-complete-http-effect.mjs";
import {
  createEngineClaimHttpEffect,
  createEnginePromptHttpEffect,
} from "./engine-claim-http-effect.mjs";
import {
  createEngineLeaseRenewHttpEffect,
} from "./engine-lease-http-effect.mjs";
import {
  runEngineAttemptTarget,
} from "./engine-attempt-runtime.mjs";
import {
  runEngineAcceptanceCanary,
} from "./engine-acceptance-canary.mjs";
import {
  engineDeclarationHash,
  ENGINE_NAMES,
  parseEngineReportAck,
  parseEngineReportBody,
} from "./engine-report-contract.mjs";
import {
  buildEngineReport,
  collectEngineInventory,
  encodeEngineConfiguration,
  resolveEngineExecutionReady,
  validateEngineProbeDirectory,
} from "./engine-probes.mjs";
import {
  createEngineAcceptanceProcessAdapter,
  createEngineFilesystemAdapter,
  createEngineProcessAdapter,
} from "./engine-adapters.mjs";
import {
  EngineReportStateError,
  readEngineReportState,
  shouldSuppressEngineReport,
  writeEngineReportState,
} from "./engine-report-state.mjs";
import {
  EngineServeCommandError,
  runEngineServeCommand,
} from "./engine-serve-command.mjs";
import {
  runEngineRecoveryCycle,
} from "./engine-serve-cycle.mjs";
import {
  resumeSupervisedAttempt,
  runSupervisedAttempt,
} from "./engine-supervised-run.mjs";

const CLI_VERSION = "0.6.0";
const STATE_VERSION = 1;
const DEFAULT_INTERVAL_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const LEASE_RENEW_INTERVAL_MS = 20_000;
const DIAGNOSTIC_HOLD_MS = 45_000;
const ENGINE_PROBE_SCRATCH_STALE_MS = 5 * 60 * 1_000;
const ENGINE_PROBE_SWEEP_MAX = 32;
const PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const PRINCIPAL_ID_PATTERN = /^prn_[0-9a-f]{32}$/u;
const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/u;
const REPORT_ID_PATTERN = /^cap_[0-9a-f]{32}$/u;
const ENGINE_COMPLETE_SERVER_ERRORS = new Set([
  "cancellation_not_requested",
  "conflict_retry",
  "engine_deadline_exhausted",
  "engine_mismatch",
  "engine_version_mismatch",
  "lease_expired",
  "lease_superseded",
  "nonce_reused",
  "operation_conflict",
  "operation_horizon_exceeded",
  "run_operation_failed",
  "run_unavailable",
  "runner_audience_unconfigured",
  "runner_rejected",
]);
const PLATFORM_OSES = new Set([
  "aix",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32",
]);
const PLATFORM_ARCHITECTURES = new Set([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class EngineCompletionDeliveryError extends Error {
  constructor(details) {
    super(engineCompletionErrorMessage(details.code));
    this.name = "EngineCompletionDeliveryError";
    this.code = details.code;
    this.outboxStatus = details.outboxStatus;
    this.operationId = details.operationId;
    this.runId = details.runId;
    this.httpStatus = details.httpStatus;
    this.serverError = details.serverError;
    this.exitCodeHint = details.exitCodeHint;
    Object.freeze(this);
  }
}

if (isDirectRunnerExecution()) {
  try {
    const command = process.argv[2] ?? "help";
    const engineCommand = command === "engines"
      ? process.argv[3]
      : undefined;
    const args = parseArgs(process.argv.slice(command === "engines" ? 4 : 3));
    if (command === "help" || command === "--help" || command === "-h") {
      printHelp();
    } else if (command === "version" || command === "--version") {
      process.stdout.write(`${CLI_VERSION}\n`);
    } else if (command === "enroll") {
      await enroll(args);
    } else if (command === "heartbeat") {
      await heartbeatOnce(args);
    } else if (command === "report-capabilities") {
      await reportCapabilities(args);
    } else if (command === "run") {
      await heartbeatLoop(args);
    } else if (command === "serve") {
      await serve(args);
    } else if (command === "diagnose") {
      await diagnose(args);
    } else if (command === "outbox") {
      await inspectOutbox(args);
    } else if (command === "engines") {
      await engines(engineCommand, args);
    } else {
      throw new CliError("Unknown command.", 64);
    }
  } catch (error) {
    const normalized =
      error instanceof CliError
        ? error
        : error instanceof OutboxError
          ? new CliError(
              error.message,
              error.code === "runner_already_running" ? 3 : 78,
            )
        : error instanceof EngineConfigStoreError
          ? new CliError(error.message, 78)
        : error instanceof EngineReportStateError
          ? new CliError(error.message, 78)
        : error instanceof EngineServeCommandError
          ? new CliError(error.message, error.exitCode)
        : new CliError("The runner command failed unexpectedly.", 1);
    process.stderr.write(`nexus-runner: ${normalized.message}\n`);
    process.exitCode = normalized.exitCode;
  }
}

function isDirectRunnerExecution() {
  if (!process.argv[1]) return false;
  const argumentPath = resolve(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  try {
    const canonical = realpathSync.native ?? realpathSync;
    return canonical(argumentPath) === canonical(modulePath);
  } catch {
    return argumentPath === modulePath;
  }
}

async function engines(command, options) {
  try {
    return await runEngineCommand(command, options);
  } catch (error) {
    if (error instanceof CliError) {
      if (error.exitCode === 73) {
        throw new CliError(
          "The engine state directory is invalid or unsafe.",
          78,
        );
      }
      throw error;
    }
    if (
      error instanceof OutboxError ||
      error instanceof EngineConfigStoreError ||
      error instanceof EngineReportStateError
    ) {
      throw error;
    }
    throw new CliError("The engine command failed safely.", 78);
  }
}

async function runEngineCommand(command, options) {
  if (!["set", "remove", "inspect", "report"].includes(command)) {
    throw new CliError("Unknown engines command.", 64);
  }
  const allowed = command === "set"
    ? ["engine", "path", "state-dir"]
    : command === "remove"
      ? ["engine", "state-dir"]
      : command === "report"
        ? ["server", "state-dir", "dry-run"]
      : ["state-dir"];
  assertOnlyOptions(options, allowed);
  const engine = ["inspect", "report"].includes(command)
    ? undefined
    : requiredEngine(options);
  const executablePath = command === "set"
    ? requiredOption(options, "path")
    : undefined;
  if (command === "set") {
    try {
      encodeEngineConfiguration({
        engines: { [engine]: { executablePath } },
        schemaVersion: 1,
      });
    } catch {
      throw new CliError(
        "--path must be a canonical absolute path.",
        64,
      );
    }
  }
  const stateDir = stateDirectory(options);
  if (command === "report") {
    const dryRun = Boolean(options["dry-run"]);
    if (dryRun && optionalOption(options, "server")) {
      throw new CliError("--server is not used with --dry-run.", 64);
    }
    if (dryRun) {
      const snapshot = await engineReportSnapshot(stateDir);
      process.stdout.write(`${snapshot.body.toString("utf8")}\n`);
      return;
    }
    await reportEngines({
      serverOverride: optionalOption(options, "server"),
      stateDir,
    });
    return;
  }
  await ensureStateDirectory(stateDir);
  const releaseLock = await acquireOutboxLock(stateDir);
  try {
    const configuration = await readEngineConfiguration(stateDir);
    if (command === "inspect") {
      process.stdout.write(
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      return;
    }
    const engines = { ...configuration.engines };
    if (command === "set") {
      engines[engine] = { executablePath };
    } else {
      delete engines[engine];
    }
    const next = { engines, schemaVersion: 1 };
    await writeEngineConfiguration(stateDir, next);
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
  } finally {
    await releaseLock();
  }
}

async function reportEngines({ serverOverride, stateDir }) {
  await ensureStateDirectory(stateDir);
  const releaseLock = await acquireOutboxLock(stateDir);
  try {
    let entries = await recoverOutbox(stateDir, reportCorruptEntry);
    await pruneOutbox(stateDir);
    entries = await recoverOutbox(stateDir, reportCorruptEntry);
    const context = await runnerContext({ stateDir, serverOverride });
    const pending = entries.filter(
      (entry) =>
        entry.v === 3 &&
        entry.declarationKind === "engine.report" &&
        entry.status === "pending",
    );
    if (pending.length > 1) {
      throw new CliError(
        "Multiple pending engine reports require operator inspection.",
        78,
      );
    }
    if (pending[0]?.runnerId !== undefined &&
        pending[0].runnerId !== context.state.runnerId) {
      throw new CliError(
        "A pending engine report belongs to another runner identity.",
        78,
      );
    }

    const snapshot = await engineReportSnapshot(stateDir);
    await sweepStaleEngineProbeDirectories(stateDir);
    const currentReport = parseEngineReportBody(snapshot.body);
    if (!currentReport) {
      throw new CliError(
        "The local engine report could not be assembled.",
        78,
      );
    }
    const currentDeclarationHash = engineDeclarationHash(currentReport);
    let entry = pending[0];
    let recovered = Boolean(entry);
    let replaced = false;
    if (entry) {
      const pendingReport = parseEngineReportBody(operationBody(entry));
      if (
        !pendingReport ||
        engineDeclarationHash(pendingReport) !== currentDeclarationHash
      ) {
        await transitionOperation(stateDir, entry, "abandoned");
        entry = undefined;
        recovered = false;
        replaced = true;
      }
    }

    if (!entry && !replaced) {
      const suppression = await readEngineReportState(stateDir);
      if (
        shouldSuppressEngineReport(
          suppression,
          snapshot.changeFingerprint,
          new Date(),
        )
      ) {
        process.stdout.write(
          `${JSON.stringify({
            status: "suppressed",
            runnerId: context.state.runnerId,
            nextReportBy: suppression.nextReportBy,
          })}\n`,
        );
        return;
      }
    }

    if (!entry) {
      entry = await persistDeclarationOperation(stateDir, {
        body: snapshot.body,
        declarationKind: "engine.report",
        operationId: generateLocalOperationId(),
        reportId: currentReport.reportId,
        runnerId: context.state.runnerId,
      });
      testCrash("after-engine-report-persist");
    }
    const result = await deliverEngineReport(context, stateDir, entry);
    testCrash("after-engine-report-ack");
    try {
      await writeEngineReportState(stateDir, {
        changeFingerprint: snapshot.changeFingerprint,
        nextReportBy: result.nextReportBy,
        schemaVersion: 1,
      });
    } catch {
      throw new CliError(
        "NexusOS accepted the engine report, but local suppression state could not be stored.",
        78,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        status: "reported",
        runnerId: context.state.runnerId,
        reportId: result.reportId,
        receivedAt: result.receivedAt,
        nextReportBy: result.nextReportBy,
        replay: result.replay,
        durableReplay: true,
        recovered,
        replaced,
      })}\n`,
    );
  } finally {
    await releaseLock();
  }
}

async function engineReportSnapshot(stateDir) {
  if (
    !["darwin", "linux"].includes(process.platform) ||
    typeof process.geteuid !== "function" ||
    typeof process.getegid !== "function" ||
    typeof process.getgroups !== "function"
  ) {
    throw new CliError(
      "This platform cannot safely probe local engines.",
      78,
    );
  }
  const identity = {
    egid: process.getegid(),
    euid: process.geteuid(),
    groups: process.getgroups(),
    platform: process.platform,
  };
  const filesystem = createEngineFilesystemAdapter();
  if (await pathExists(stateDir)) {
    const directStateFacts = await filesystem.lstat(stateDir);
    const validatedState = await validateEngineProbeDirectory(
      { ...identity, path: stateDir },
      filesystem,
    );
    if (
      directStateFacts.kind !== "directory" ||
      validatedState.kind !== "valid"
    ) {
      throw new CliError(
        "The engine state directory is invalid or unsafe.",
        78,
      );
    }
  }
  const configuration = await readEngineConfiguration(stateDir);
  let probeDirectory = resolve(stateDir);
  let scratchDirectory;
  try {
    if (Object.keys(configuration.engines).length > 0) {
      try {
        scratchDirectory = await mkdtemp(
          join(
            dirname(stateDir),
            engineProbeScratchPrefix(stateDir),
          ),
        );
        await chmod(scratchDirectory, 0o700);
        const validated = await validateEngineProbeDirectory(
          { ...identity, path: scratchDirectory },
          filesystem,
        );
        if (validated.kind !== "valid") {
          throw new Error("unsafe");
        }
        probeDirectory = validated.realPath;
      } catch {
        throw new CliError(
          "A private engine probe directory could not be established.",
          78,
        );
      }
    }
    const collectedAt = new Date().toISOString();
    const inventory = await collectEngineInventory({
      collectedAt,
      configuration,
      filesystem,
      home: resolve(homedir()),
      identity,
      locale: "C",
      process: createEngineProcessAdapter(),
      tmpdir: probeDirectory,
    });
    return {
      body: buildEngineReport({
        collectedAt,
        probes: inventory.probes,
        reportId: `egr_${randomBytes(16).toString("hex")}`,
        truncated: inventory.truncated,
      }),
      changeFingerprint: inventory.changeFingerprint,
    };
  } finally {
    if (scratchDirectory) {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  }
}

async function sweepStaleEngineProbeDirectories(
  stateDir,
  nowMs = Date.now(),
) {
  const parent = dirname(stateDir);
  const prefix = engineProbeScratchPrefix(stateDir);
  let names;
  try {
    names = await readdir(parent);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const candidates = names
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        /^[A-Za-z0-9]{6}$/u.test(name.slice(prefix.length)),
    )
    .sort()
    .slice(0, ENGINE_PROBE_SWEEP_MAX);
  for (const name of candidates) {
    const path = join(parent, name);
    try {
      const metadata = await lstat(path);
      if (
        metadata.isDirectory() &&
        metadata.uid === process.geteuid() &&
        (metadata.mode & 0o777) === 0o700 &&
        metadata.mtimeMs <= nowMs - ENGINE_PROBE_SCRATCH_STALE_MS
      ) {
        await rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function engineProbeScratchPrefix(stateDir) {
  return `.nexus-engine-probe-${createHash("sha256")
    .update(resolve(stateDir))
    .digest("hex")
    .slice(0, 16)}-`;
}

async function deliverEngineReport(context, stateDir, entry) {
  if (
    entry.v !== 3 ||
    entry.declarationKind !== "engine.report" ||
    entry.status !== "pending" ||
    entry.runnerId !== context.state.runnerId
  ) {
    throw new CliError("The pending engine report is invalid.", 78);
  }
  let response;
  let body;
  try {
    response = await signedRequest({
      audience: context.audience,
      pathname: deriveOutboxPathname(entry),
      domain: "nexus-runner-engine-report-v1",
      body: operationBody(entry),
      privateKey: context.privateKey,
      publicKey: context.publicKey,
      keyId: context.state.runnerId,
    });
    body = await readBoundedResponse(response);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "Engine report delivery is unavailable; the durable entry was preserved.",
      75,
    );
  }
  testCrash("after-engine-report-send");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }
  if (response.status === 201) {
    const acknowledgement = parseEngineReportAck(payload, entry.reportId);
    if (!acknowledgement) {
      throw new CliError(
        "NexusOS returned an invalid engine report acknowledgement; the durable entry was preserved.",
        76,
      );
    }
    await transitionOperation(stateDir, entry, "acked", {
      status: response.status,
      body,
    });
    return {
      ...acknowledgement,
      replay: response.headers.get("x-nexus-replay") === "1",
    };
  }
  if (
    response.status >= 500 ||
    response.status === 429 ||
    (response.status === 409 && payload?.error === "nonce_reused")
  ) {
    throw new CliError(
      "Engine report delivery is retryable; the durable entry was preserved.",
      75,
    );
  }
  await transitionOperation(stateDir, entry, "rejected", {
    status: response.status,
    body,
  });
  if (response.status === 401 || response.status === 403) {
    throw new CliError(
      "Engine report authentication was rejected. Inspect or revoke this runner.",
      77,
    );
  }
  if (response.status === 409 && payload?.error === "report_conflict") {
    throw new CliError(
      "Engine report identity conflicts with durable server history.",
      75,
    );
  }
  if (response.status === 410) {
    throw new CliError(
      "Engine report exceeded the durable replay horizon.",
      75,
    );
  }
  throw new CliError(
    `Engine report failed with HTTP ${response.status}.`,
    75,
  );
}

export async function deliverEngineCompletion(
  context,
  stateDir,
  entry,
) {
  const pending = await pendingEngineCompletion(
    context,
    stateDir,
    entry,
  );
  const durableEntry = pending.entry;
  const body = pending.body;
  let response;
  try {
    response = await signedRequest({
      audience: context.audience,
      pathname: deriveOutboxPathname(durableEntry),
      domain: "nexus-runner-engine-complete-v1",
      body,
      privateKey: context.privateKey,
      publicKey: context.publicKey,
      keyId: context.state.runnerId,
    });
  } catch {
    throw engineCompletionDeliveryError(durableEntry, {
      code: "retryable",
      httpStatus: null,
      outboxStatus: "pending",
      serverError: null,
    });
  }

  let responseBody;
  try {
    responseBody = await readBoundedResponseBytes(response);
  } catch (error) {
    throw engineCompletionDeliveryError(durableEntry, {
      code: error instanceof CliError ? "protocol" : "retryable",
      httpStatus: response.status,
      outboxStatus: "pending",
      serverError: null,
    });
  }
  let payload;
  try {
    payload = JSON.parse(responseBody.toString("utf8"));
  } catch {
    payload = undefined;
  }
  const classification = classifyEngineCompleteResponse(
    response.status,
    payload,
    durableEntry.runId,
  );
  if (classification.classification === "success") {
    const acknowledgement = parseEngineCompleteAck(
      payload,
      durableEntry.runId,
    );
    const settled = await transitionOperation(
      stateDir,
      durableEntry,
      "acked",
      { status: response.status, body: responseBody },
    );
    return Object.freeze({
      ack: Object.freeze({ ...acknowledgement }),
      entry: Object.freeze({ ...settled }),
      replay: response.headers.get("x-nexus-replay") === "1",
      status: "acked",
    });
  }
  const serverError = classifiedEngineCompleteServerError(payload);
  if (classification.outboxStatus === "pending") {
    throw engineCompletionDeliveryError(durableEntry, {
      code:
        classification.classification === "protocol_error"
          ? "protocol"
          : "retryable",
      httpStatus: response.status,
      outboxStatus: "pending",
      serverError,
    });
  }
  if (serverError === null) {
    throw engineCompletionDeliveryError(durableEntry, {
      code: "protocol",
      httpStatus: response.status,
      outboxStatus: "pending",
      serverError: null,
    });
  }

  await transitionOperation(
    stateDir,
    durableEntry,
    classification.outboxStatus,
    { status: response.status, body: responseBody },
  );
  throw engineCompletionDeliveryError(durableEntry, {
    code:
      response.status === 401 || response.status === 403
        ? "auth"
        : classification.outboxStatus,
    httpStatus: response.status,
    outboxStatus: classification.outboxStatus,
    serverError,
  });
}

export async function drainEngineCompletionOutbox(
  context,
  stateDir,
  entries,
) {
  const recovered = entries ?? await recoverOutbox(stateDir);
  if (!Array.isArray(recovered)) {
    throw new OutboxError("Engine completion drain entries are invalid.");
  }
  const pending = recovered.filter(
    (entry) =>
      entry?.v === 3 &&
      entry.declarationKind === "engine.complete" &&
      entry.status === "pending",
  );
  const operationIds = new Set();
  for (const entry of pending) {
    if (
      !isOutboxEntry(entry) ||
      operationIds.has(entry.operationId)
    ) {
      throw new OutboxError("Engine completion drain entries are invalid.");
    }
    operationIds.add(entry.operationId);
  }
  pending.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.operationId.localeCompare(right.operationId),
  );
  let attempted = 0;
  const delivered = [];
  const failed = [];
  let halt = null;
  for (const entry of pending) {
    attempted += 1;
    try {
      const result = await deliverEngineCompletion(
        context,
        stateDir,
        entry,
      );
      delivered.push(Object.freeze({
        late: result.ack.late,
        operationId: entry.operationId,
        recordedAt: result.ack.recordedAt,
        replay: result.replay,
        runId: entry.runId,
      }));
    } catch (error) {
      if (!(error instanceof EngineCompletionDeliveryError)) throw error;
      const outcome = completionDeliveryOutcome(error);
      if (error.code === "superseded" || error.code === "rejected") {
        failed.push(outcome);
        continue;
      }
      halt = Object.freeze({
        ...outcome,
        exitCodeHint: error.exitCodeHint,
      });
      break;
    }
  }
  const terminalHalt = halt?.code === "auth" ? 1 : 0;
  return Object.freeze({
    attempted,
    delivered: Object.freeze(delivered),
    failed: Object.freeze(failed),
    halt,
    remainingPending:
      pending.length -
      delivered.length -
      failed.length -
      terminalHalt,
  });
}

async function enroll(options) {
  assertOnlyOptions(options, [
    "server",
    "name",
    "state-dir",
    "token-stdin",
  ]);
  const audience = normalizeAudience(requiredOption(options, "server"));
  const displayName = requiredOption(options, "name").trim();
  if (
    displayName.length < 1 ||
    displayName.length > 120 ||
    displayName !== requiredOption(options, "name")
  ) {
    throw new CliError(
      "--name must contain 1 to 120 characters without surrounding whitespace.",
      64,
    );
  }
  const stateDir = stateDirectory(options);
  await ensureStateDirectory(stateDir);
  const paths = statePaths(stateDir);
  if (await pathExists(paths.config)) {
    throw new CliError(
      `This state directory is already enrolled. Use "heartbeat" or "run".`,
      64,
    );
  }

  const releaseLock = await acquireEnrollmentLock(paths.lock);
  let privateKey;
  let publicKey;
  let createdThisInvocation = false;
  try {
    const token = await readEnrollmentToken(Boolean(options["token-stdin"]));
    if (!isCanonicalToken(token)) {
      throw new CliError("The enrollment token is malformed.", 64);
    }
    if (await pathExists(paths.key)) {
      privateKey = await readPrivateKey(paths.key);
    } else {
      const staged = await createStagedIdentity(paths.key);
      privateKey = staged.privateKey;
      createdThisInvocation = staged.created;
    }
    publicKey = rawPublicKey(privateKey);

    const body = Buffer.from(JSON.stringify({ displayName }), "utf8");
    let response;
    try {
      response = await signedRequest({
        audience,
        pathname: "/api/runners/enroll",
        domain: "nexus-runner-enroll-v1",
        body,
        privateKey,
        publicKey,
        authorization: `Bearer ${token}`,
      });
    } catch {
      throw new CliError(
        `Enrollment outcome is unknown. The staged identity was retained at ${stateDir}; retry the same command with the same token.`,
        75,
      );
    }

    const responseBody = await readBoundedResponse(response);
    if (!response.ok) {
      if (isDefinitiveEnrollmentRejection(response.status)) {
        if (createdThisInvocation) {
          await removeStagedIdentity(paths.key);
        }
        throw new CliError(
          createdThisInvocation
            ? `Enrollment was rejected by NexusOS (HTTP ${response.status}); the newly staged identity was removed.`
            : `Enrollment was rejected by NexusOS (HTTP ${response.status}); the retained recovery identity was preserved.`,
          77,
        );
      }
      throw new CliError(
        `Enrollment outcome is not safe to discard (HTTP ${response.status}). The staged identity was retained; retry with the same token.`,
        75,
      );
    }

    const enrollment = parseEnrollment(responseBody);
    const state = {
      version: STATE_VERSION,
      audience,
      displayName,
      publicKey,
      runnerId: enrollment.runnerId,
      principalId: enrollment.principalId,
      organizationId: enrollment.organizationId,
      enrolledAt: enrollment.enrolledAt,
      trustProfile: enrollment.trustProfile,
    };
    try {
      await writeState(paths.config, state);
    } catch {
      throw new CliError(
        `NexusOS accepted the identity, but local state could not be finalized. The staged key was retained; retry the same enrollment command.`,
        74,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        status: "enrolled",
        runnerId: state.runnerId,
        displayName: state.displayName,
        trustProfile: state.trustProfile,
      })}\n`,
    );
  } finally {
    await releaseLock();
  }
}

async function heartbeatOnce(options) {
  assertOnlyOptions(options, ["server", "state-dir"]);
  const stateDir = stateDirectory(options);
  const result = await sendHeartbeat({
    stateDir,
    serverOverride: optionalOption(options, "server"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function reportCapabilities(options) {
  assertOnlyOptions(options, ["server", "state-dir", "dry-run"]);
  const dryRun = Boolean(options["dry-run"]);
  if (dryRun && optionalOption(options, "server")) {
    throw new CliError("--server is not used with --dry-run.", 64);
  }
  if (dryRun) {
    process.stdout.write(
      `${(await capabilityReportBody()).toString("utf8")}\n`,
    );
    return;
  }

  const stateDir = stateDirectory(options);
  const releaseLock = await acquireOutboxLock(stateDir);
  try {
    let entries = await recoverOutbox(stateDir, reportCorruptEntry);
    await pruneOutbox(stateDir);
    entries = await recoverOutbox(stateDir, reportCorruptEntry);
    const context = await runnerContext({
      stateDir,
      serverOverride: optionalOption(options, "server"),
    });
    let entry = entries.find(
      (candidate) =>
        candidate.kind === "capability.report" &&
        candidate.status === "pending",
    );
    const recovered = Boolean(entry);
    if (!entry) {
      const body = await capabilityReportBody();
      const reportId = JSON.parse(body.toString("utf8")).reportId;
      entry = await persistOperation(stateDir, {
        operationId: generateLocalOperationId(),
        kind: "capability.report",
        runnerId: context.state.runnerId,
        reportId,
        body,
      });
      testCrash("after-report-persist");
    }
    const result = await deliverCapabilityReport(
      context,
      stateDir,
      entry,
    );
    process.stdout.write(
      `${JSON.stringify({
        status: "reported",
        runnerId: context.state.runnerId,
        reportId: result.reportId,
        receivedAt: result.receivedAt,
        replay: result.replay,
        durableReplay: true,
        recovered,
      })}\n`,
    );
  } finally {
    await releaseLock();
  }
}

async function capabilityReportBody() {
  const fixturePath = process.env.NEXUS_RUNNER_TEST_REPORT_FILE;
  if (fixturePath) {
    if (process.env.NEXUS_RUNNER_TEST !== "1") {
      throw new CliError(
        "Capability report fixture injection is test-only.",
        64,
      );
    }
    const bytes = await readFile(fixturePath);
    if (bytes.byteLength < 1 || bytes.byteLength > 4_096) {
      throw new CliError("The test capability report is not bounded.", 78);
    }
    const text = bytes.toString("utf8").trimEnd();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CliError("The test capability report is invalid.", 78);
    }
    if (
      !REPORT_ID_PATTERN.test(parsed?.reportId ?? "") ||
      canonicalJson(parsed) !== text
    ) {
      throw new CliError(
        "The test capability report is not canonical.",
        78,
      );
    }
    return Buffer.from(text, "utf8");
  }
  if (
    !PLATFORM_OSES.has(process.platform) ||
    !PLATFORM_ARCHITECTURES.has(process.arch) ||
    !/^v\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/u.test(
      process.version,
    )
  ) {
    throw new CliError(
      "This platform cannot produce a canonical capability baseline.",
      78,
    );
  }
  const testRoot = capabilityProbeTestRoot();
  const capabilities = capabilityProbesDisabled()
    ? CAPABILITY_ORDER.map((capability) => ({
        capability,
        detection: "none",
        reasonCode: "probe_disabled",
        status: "unknown",
      }))
    : await collectCapabilityEvidence({
        testRoot,
      });
  return Buffer.from(
    canonicalJson({
      capabilities,
      collectedAt: new Date().toISOString(),
      platform: {
        arch: process.arch,
        nodeVersion: process.version,
        os: process.platform,
      },
      reportId: `cap_${randomBytes(16).toString("hex")}`,
      schemaVersion: 1,
      truncated: false,
    }),
    "utf8",
  );
}

function capabilityProbesDisabled() {
  const value = process.env.NEXUS_RUNNER_DISABLE_PROBES;
  if (value === undefined) return false;
  if (value !== "1") {
    throw new CliError(
      "NEXUS_RUNNER_DISABLE_PROBES accepts only the value 1.",
      64,
    );
  }
  return true;
}

function capabilityProbeTestRoot() {
  const root = process.env.NEXUS_RUNNER_TEST_PROBE_ROOT;
  if (root === undefined) return undefined;
  if (process.env.NEXUS_RUNNER_TEST !== "1") {
    throw new CliError(
      "Capability probe root injection is test-only.",
      64,
    );
  }
  const temporaryRoot = resolve(tmpdir());
  if (
    root.length < 1 ||
    root.length > 1_024 ||
    resolve(root) !== root ||
    !root.startsWith(`${temporaryRoot}${sep}`)
  ) {
    throw new CliError(
      "The test capability probe root must be a bounded temporary path.",
      64,
    );
  }
  return root;
}

async function heartbeatLoop(options) {
  assertOnlyOptions(options, ["server", "state-dir", "interval-seconds"]);
  const stateDir = stateDirectory(options);
  const rawInterval =
    optionalOption(options, "interval-seconds") ??
    String(DEFAULT_INTERVAL_SECONDS);
  if (!/^\d{2,3}$/u.test(rawInterval)) {
    throw new CliError("--interval-seconds must be an integer from 10 to 300.", 64);
  }
  const intervalSeconds = Number(rawInterval);
  if (intervalSeconds < 10 || intervalSeconds > 300) {
    throw new CliError("--interval-seconds must be an integer from 10 to 300.", 64);
  }

  let stopping = false;
  const stopController = new AbortController();
  const stop = () => {
    stopping = true;
    stopController.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(
    `${JSON.stringify({ status: "started", intervalSeconds })}\n`,
  );
  while (!stopping) {
    try {
      const result = await sendHeartbeat({
        stateDir,
        serverOverride: optionalOption(options, "server"),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      if (
        error instanceof CliError &&
        [64, 66, 77, 78].includes(error.exitCode)
      ) {
        throw error;
      }
      process.stderr.write(
        `nexus-runner: heartbeat unavailable; retrying in ${intervalSeconds}s.\n`,
      );
    }
    if (!stopping) {
      await interruptibleDelay(
        intervalSeconds * 1_000,
        stopController.signal,
      );
    }
  }
  process.stdout.write(`${JSON.stringify({ status: "stopped" })}\n`);
}

async function serve(options) {
  assertOnlyOptions(options, [
    "engine",
    "interval-seconds",
    "run",
    "server",
    "state-dir",
  ]);
  const stateDir = stateDirectory(options);
  const intervalSeconds = serveIntervalSeconds(options);
  const runId = optionalOption(options, "run");
  const engineOption = optionalOption(options, "engine");
  if ((runId === undefined) !== (engineOption === undefined)) {
    throw new CliError(
      "--run and --engine must be provided together.",
      64,
    );
  }
  let target;
  if (runId !== undefined) {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new CliError(
        "--run must be a canonical NexusOS run id.",
        64,
      );
    }
    const engine = requiredEngine(options);
    target = { engine, runId };
  }
  const performCompletionEffect = createEngineCompletionHttpEffect({
    signedRequest,
  });
  const performClaimEffect = createEngineClaimHttpEffect({
    signedRequest,
  });
  const performPromptEffect = createEnginePromptHttpEffect({
    signedRequest,
  });
  const performRenewEffect = createEngineLeaseRenewHttpEffect({
    signedRequest,
  });
  const result = await runEngineServeCommand(
    {
      intervalSeconds,
      serverOverride: optionalOption(options, "server"),
      stateDir,
      ...(target ? { target } : {}),
    },
    {
      acquireStateLock: acquireOutboxLock,
      delay: interruptibleDelay,
      emit(value) {
        process.stdout.write(`${JSON.stringify(value)}\n`);
      },
      emitError(value) {
        process.stderr.write(value);
      },
      loadCompletionContext: runnerContext,
      performCompletionEffect,
      random: Math.random,
      runAttemptTarget(input, ownershipCapability) {
        return runEngineAttemptTarget(
          input,
          {
            delay: interruptibleDelay,
            performClaimEffect,
            performPromptEffect,
            performRenewEffect,
            resolveReadiness: resolveFreshEngineExecutionReadiness,
            resumeSupervisedAttempt,
            runSupervisedAttempt,
          },
          ownershipCapability,
        );
      },
      runRecoveryCycle: runEngineRecoveryCycle,
      sendHeartbeat,
      subscribeSignals(stop) {
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return () => {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        };
      },
      async yieldControl() {
        await new Promise((resolveYield) =>
          setImmediate(resolveYield)
        );
      },
    },
  );
  if (result.exitCode !== 0) {
    throw new CliError(serveFailureMessage(result), result.exitCode);
  }
}

export async function resolveFreshEngineExecutionReadiness(input) {
  if (
    !input ||
    !ENGINE_NAMES.includes(input.engine) ||
    typeof input.expectedVersion !== "string" ||
    typeof input.stateDir !== "string" ||
    (
      input.signal !== undefined &&
      !isAbortSignal(input.signal)
    ) ||
    (
      input.leaseExpiresAt !== undefined &&
      !canonicalIsoTimestamp(input.leaseExpiresAt)
    )
  ) {
    throw new CliError(
      "Engine execution readiness input is invalid.",
      78,
    );
  }
  if (input.signal?.aborted) {
    return Object.freeze({
      kind: "not_ready",
      reason: "engine_readiness_aborted",
    });
  }
  const identity = localEngineProbeIdentity();
  const filesystem = createEngineFilesystemAdapter();
  const stateDir = resolve(input.stateDir);
  const directStateFacts = await filesystem.lstat(stateDir);
  const validatedState = await validateEngineProbeDirectory(
    { ...identity, path: stateDir },
    filesystem,
  );
  if (
    directStateFacts.kind !== "directory" ||
    validatedState.kind !== "valid"
  ) {
    throw new CliError(
      "The engine state directory is invalid or unsafe.",
      78,
    );
  }
  const configuration = await readEngineConfiguration(stateDir);
  let scratchDirectory;
  try {
    scratchDirectory = await mkdtemp(
      join(
        dirname(stateDir),
        engineProbeScratchPrefix(stateDir),
      ),
    );
    await chmod(scratchDirectory, 0o700);
    const validatedScratch = await validateEngineProbeDirectory(
      { ...identity, path: scratchDirectory },
      filesystem,
    );
    if (validatedScratch.kind !== "valid") {
      throw new CliError(
        "A private engine probe directory could not be established.",
        78,
      );
    }
    const readiness = await resolveEngineExecutionReady({
      configuration,
      engine: input.engine,
      expectedVersion: input.expectedVersion,
      filesystem,
      home: resolve(homedir()),
      identity,
      locale: "C",
      process: createEngineProcessAdapter(),
      tmpdir: validatedScratch.realPath,
    });
    if (input.signal?.aborted) {
      return Object.freeze({
        kind: "not_ready",
        reason: "engine_readiness_aborted",
      });
    }
    if (readiness.kind !== "ready") return readiness;
    const remainingLeaseMs = input.leaseExpiresAt
      ? Date.parse(input.leaseExpiresAt) - Date.now() - 2_000
      : 45_000;
    if (remainingLeaseMs < 5_000) {
      return Object.freeze({
        kind: "not_ready",
        reason: "engine_lease_horizon_exhausted",
      });
    }
    const canary = await runEngineAcceptanceCanary(
      {
        engine: readiness.engine,
        engineVersion: readiness.engineVersion,
        executableRealPath: readiness.executableRealPath,
        fingerprintFacts: readiness.fingerprintFacts,
        home: resolve(homedir()),
        scratchRoot: validatedScratch.realPath,
        signal: input.signal ?? new AbortController().signal,
        timeoutMs: Math.min(45_000, remainingLeaseMs),
      },
      createEngineAcceptanceProcessAdapter(),
    );
    if (input.signal?.aborted) {
      return Object.freeze({
        kind: "not_ready",
        reason: "engine_readiness_aborted",
      });
    }
    if (canary.kind !== "ready") {
      return Object.freeze({
        kind: "not_ready",
        reason: "engine_acceptance_canary_failed",
      });
    }
    return readiness;
  } finally {
    if (scratchDirectory) {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  }
}

function localEngineProbeIdentity() {
  if (
    !["darwin", "linux"].includes(process.platform) ||
    typeof process.geteuid !== "function" ||
    typeof process.getegid !== "function" ||
    typeof process.getgroups !== "function"
  ) {
    throw new CliError(
      "This platform cannot safely probe local engines.",
      78,
    );
  }
  return {
    egid: process.getegid(),
    euid: process.geteuid(),
    groups: process.getgroups(),
    platform: process.platform,
  };
}

function isAbortSignal(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.aborted === "boolean" &&
      typeof value.addEventListener === "function"
  );
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Boolean(
    Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
  );
}

function serveIntervalSeconds(options) {
  const rawInterval =
    optionalOption(options, "interval-seconds") ??
    String(DEFAULT_INTERVAL_SECONDS);
  if (!/^(?:[1-9]\d|[12]\d{2}|300)$/u.test(rawInterval)) {
    throw new CliError(
      "--interval-seconds must be an integer from 10 to 300.",
      64,
    );
  }
  const intervalSeconds = Number(rawInterval);
  if (intervalSeconds < 10 || intervalSeconds > 300) {
    throw new CliError(
      "--interval-seconds must be an integer from 10 to 300.",
      64,
    );
  }
  return intervalSeconds;
}

export function serveFailureMessage(result) {
  const reason = result.reason;
  let message;
  if (reason === "durable_auth_rejected") {
    message = "Runner authentication was durably rejected; serve stopped.";
  }
  else if (
    reason === "heartbeat_auth_rejected" ||
    reason === "serve_auth_rejected" ||
    reason === "recovery_auth_rejected" ||
    reason === "execution_auth_rejected"
  ) {
    message = "Runner authentication was rejected; verify enrollment or revocation.";
  }
  else if (
    reason === "heartbeat_failure_budget" ||
    reason === "recovery_failure_budget" ||
    reason === "execution_failure_budget"
  ) {
    message = "Runner serve exhausted its bounded retry budget.";
  }
  else if (reason === "execution_protocol_invalid") {
    message =
      "The execution control service returned an invalid protocol response; operator attention is required.";
  }
  else if (reason.endsWith("_configuration_invalid")) {
    message = "Runner serve configuration does not match the enrolled runner.";
  }
  else if (reason.endsWith("_state_missing")) {
    message = "Runner state is missing; enroll this runner before serving.";
  }
  else if (
    reason.endsWith("_state_invalid") ||
    reason.endsWith("_invalid") ||
    reason === "runner_lock_ownership_in_use"
  ) {
    message = "Runner state or local recovery data is invalid; operator attention is required.";
  }
  else if (
    reason === "heartbeat_delay_failed" ||
    reason === "recovery_delay_failed" ||
    reason === "execution_delay_failed" ||
    reason === "serve_failed"
  ) {
    message = "Runner serve stopped after an unexpected local failure.";
  }
  else {
    message = "Runner serve stopped safely.";
  }
  if (
    result.releaseDisposition === "stale_possible" &&
    reason !== "lock_release_failed"
  ) {
    return `${message} Its state lock may be stale.`;
  }
  if (reason === "lock_release_failed") {
    return "Runner serve stopped but its state lock may be stale.";
  }
  return message;
}

async function diagnose(options) {
  assertOnlyOptions(options, ["server", "state-dir", "run"]);
  const runId = requiredOption(options, "run");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new CliError("--run must be a canonical NexusOS run id.", 64);
  }
  const stateDir = stateDirectory(options);
  const releaseLock = await acquireOutboxLock(stateDir);
  try {
    let entries = await recoverOutbox(stateDir, reportCorruptEntry);
    await pruneOutbox(stateDir);
    const context = await runnerContext({
      stateDir,
      serverOverride: optionalOption(options, "server"),
    });

    let recoveredCompletion = false;
    for (const entry of entries.filter(
      (candidate) =>
        candidate.kind === "run.complete" &&
        candidate.status === "pending",
    )) {
      await deliverCompletion(context, stateDir, entry);
      if (entry.runId === runId) recoveredCompletion = true;
    }
    if (recoveredCompletion) {
      process.stdout.write(
        `${JSON.stringify({
          status: "completed",
          runId,
          durableReplay: true,
          recovered: true,
        })}\n`,
      );
      return;
    }

    entries = await recoverOutbox(stateDir, reportCorruptEntry);
    const foreignPendingClaim = entries.find(
      (entry) =>
        entry.kind === "lease.claim" &&
        entry.status === "pending" &&
        entry.runId !== runId,
    );
    if (foreignPendingClaim) {
      throw new CliError(
        `A pending claim for ${foreignPendingClaim.runId} must be recovered first.`,
        75,
      );
    }

    const acknowledgedCompletion = entries.some(
      (entry) =>
        entry.kind === "run.complete" &&
        entry.status === "acked" &&
        entry.runId === runId,
    );
    if (acknowledgedCompletion) {
      process.stdout.write(
        `${JSON.stringify({
          status: "already_completed",
          runId,
          durableReplay: true,
        })}\n`,
      );
      return;
    }

    let claimEntry = latestClaim(entries, runId);
    let claim = claimEntry ? storedClaim(claimEntry) : undefined;
    if (claim && Date.parse(claim.expiresAt) <= Date.now()) {
      claim = undefined;
      claimEntry = undefined;
    }
    if (!claim) {
      claimEntry =
        entries.find(
          (entry) =>
            entry.kind === "lease.claim" &&
            entry.status === "pending" &&
            entry.runId === runId,
        ) ?? (await createClaimOperation(stateDir, runId));
      testCrash("after-claim-persist");
      claim = await deliverClaim(context, stateDir, claimEntry);
      if (Date.parse(claim.expiresAt) <= Date.now()) {
        await transitionOperation(
          stateDir,
          claimEntry,
          "superseded",
          null,
        );
        const freshClaim = await createClaimOperation(stateDir, runId);
        claimEntry = freshClaim;
        claim = await deliverClaim(context, stateDir, freshClaim);
      }
    }

    process.stdout.write(
      `${JSON.stringify({
        status: "leased",
        runId,
        leaseId: claim.leaseId,
        fence: claim.fence,
      })}\n`,
    );
    const canceled = await holdDiagnosticLease(context, claim);
    const completionEntry = await createCompletionOperation(
      stateDir,
      claim,
      canceled ? "canceled" : "succeeded",
      canceled
        ? "Diagnostic stopped after a governed cancellation request."
        : "Diagnostic lease completed without executing user work.",
    );
    testCrash("after-complete-persist");
    const completion = await deliverCompletion(
      context,
      stateDir,
      completionEntry,
    );
    process.stdout.write(
      `${JSON.stringify({
        status: "completed",
        runId,
        fence: claim.fence,
        late: completion.late,
        durableReplay: true,
      })}\n`,
    );
  } finally {
    await releaseLock();
  }
}

async function inspectOutbox(options) {
  assertOnlyOptions(options, ["state-dir"]);
  const stateDir = stateDirectory(options);
  const releaseLock = await acquireOutboxLock(stateDir);
  try {
    await recoverOutbox(stateDir, reportCorruptEntry);
    const pruned = await pruneOutbox(stateDir);
    const entries = await recoverOutbox(stateDir);
    process.stdout.write(
      `${JSON.stringify({
        status: "outbox",
        pending: entries.filter((entry) => entry.status === "pending").length,
        terminal: entries.filter((entry) => entry.status !== "pending").length,
        pruned,
        operations: entries.map((entry) => ({
          v: entry.v,
          operationId: entry.operationId,
          kind: entry.kind ?? entry.declarationKind,
          runId: entry.runId,
          runnerId: entry.runnerId,
          reportId: entry.reportId,
          status: entry.status,
          updatedAt: entry.updatedAt,
        })),
      })}\n`,
    );
  } finally {
    await releaseLock();
  }
}

async function sendHeartbeat({ stateDir, serverOverride }) {
  const { state, privateKey, publicKey, audience } = await runnerContext({
    stateDir,
    serverOverride,
  });
  const pathname = `/api/runners/${state.runnerId}/heartbeat`;
  let response;
  try {
    response = await signedRequest({
      audience,
      pathname,
      domain: "nexus-runner-heartbeat-v1",
      body: Buffer.from("{}", "utf8"),
      privateKey,
      publicKey,
    });
  } catch {
    throw new CliError("NexusOS could not be reached for heartbeat.", 75);
  }
  const body = await readBoundedResponse(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CliError(
        `Runner authentication was rejected (HTTP ${response.status}). Re-enrollment requires a new state directory and token.`,
        77,
      );
    }
    throw new CliError(
      `Heartbeat failed with HTTP ${response.status}; retry is safe.`,
      75,
    );
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new CliError("NexusOS returned an invalid heartbeat response.", 76);
  }
  return {
    status: "heartbeat",
    runnerId: state.runnerId,
    observedAt: payload.observedAt,
    nextHeartbeatSeconds: payload.nextHeartbeatSeconds,
    replay: response.headers.get("x-nexus-replay") === "1",
  };
}

async function signedRequest({
  audience,
  pathname,
  domain,
  body,
  privateKey,
  publicKey,
  keyId,
  authorization,
  signal,
}) {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(16).toString("base64url");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const stringToSign = [
    domain,
    ...(keyId ? [keyId] : []),
    "POST",
    pathname,
    audience,
    timestamp,
    nonce,
    `sha256:${bodyHash}`,
  ].join("\n");
  const signature = sign(null, Buffer.from(stringToSign, "utf8"), privateKey);
  const requestSignal = signal
    ? AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fetch(`${audience}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.byteLength),
      "x-nexus-runner-key": publicKey,
      ...(keyId ? { "x-nexus-runner-id": keyId } : {}),
      "x-nexus-signature": signature.toString("base64url"),
      "x-nexus-timestamp": timestamp,
      "x-nexus-nonce": nonce,
      ...(authorization ? { authorization } : {}),
    },
    body,
    cache: "no-store",
    redirect: "error",
    signal: requestSignal,
  });
}

async function runnerContext({ stateDir, serverOverride }) {
  const paths = statePaths(stateDir);
  const [state, privateKey] = await Promise.all([
    readState(paths.config),
    readPrivateKey(paths.key),
  ]);
  const audience = serverOverride
    ? normalizeAudience(serverOverride)
    : state.audience;
  if (audience !== state.audience) {
    throw new CliError(
      "--server must exactly match the audience saved during enrollment.",
      64,
    );
  }
  const publicKey = rawPublicKey(privateKey);
  if (publicKey !== state.publicKey) {
    throw new CliError("The local private key does not match runner state.", 78);
  }
  return { state, privateKey, publicKey, audience };
}

async function createClaimOperation(stateDir, runId) {
  const operationId = generateLocalOperationId();
  return persistOperation(stateDir, {
    operationId,
    kind: "lease.claim",
    runId,
    body: Buffer.from(canonicalJson({ operationId }), "utf8"),
  });
}

async function createCompletionOperation(
  stateDir,
  claim,
  outcomeStatus,
  summary,
) {
  const operationId = generateLocalOperationId();
  return persistOperation(stateDir, {
    operationId,
    kind: "run.complete",
    runId: claim.runId,
    body: Buffer.from(
      canonicalJson({
        fence: claim.fence,
        leaseId: claim.leaseId,
        operationId,
        outcome: { status: outcomeStatus, summary },
      }),
      "utf8",
    ),
  });
}

async function deliverClaim(context, stateDir, entry) {
  const delivered = await deliverStoredOperation(context, entry);
  if (!delivered.response.ok) {
    if (retryableClaimResponse(delivered.response, delivered.payload)) {
      throw runHttpError(
        "Lease claim",
        delivered.response,
        delivered.payload,
      );
    }
    const status = terminalOutboxStatus(delivered.response, delivered.payload);
    await transitionOperation(stateDir, entry, status, {
      status: delivered.response.status,
      body: delivered.body,
    });
    throw runHttpError("Lease claim", delivered.response, delivered.payload);
  }
  const claim = parseClaim(delivered.payload, entry.runId);
  await transitionOperation(stateDir, entry, "acked", {
    status: delivered.response.status,
    body: delivered.body,
  });
  return claim;
}

async function deliverCompletion(context, stateDir, entry) {
  let attempt = 0;
  while (true) {
    let delivered;
    try {
      delivered = await deliverStoredOperation(context, entry);
    } catch {
      attempt += 1;
      process.stderr.write(
        `nexus-runner: completion delivery unavailable; durable retry ${attempt}.\n`,
      );
      await interruptibleDelay(retryDelay(attempt), new AbortController().signal);
      continue;
    }
    testCrash("after-complete-send");
    if (delivered.response.ok) {
      const completion = parseCompletion(delivered.payload, entry.runId);
      await transitionOperation(stateDir, entry, "acked", {
        status: delivered.response.status,
        body: delivered.body,
      });
      return completion;
    }
    if (delivered.response.status >= 500 || delivered.response.status === 429) {
      attempt += 1;
      await interruptibleDelay(retryDelay(attempt), new AbortController().signal);
      continue;
    }
    const status = terminalOutboxStatus(delivered.response, delivered.payload);
    await transitionOperation(stateDir, entry, status, {
      status: delivered.response.status,
      body: delivered.body,
    });
    throw runHttpError("Run completion", delivered.response, delivered.payload);
  }
}

async function deliverCapabilityReport(context, stateDir, entry) {
  if (
    entry.kind !== "capability.report" ||
    entry.runnerId !== context.state.runnerId
  ) {
    throw new CliError(
      "A pending capability report belongs to another runner identity.",
      78,
    );
  }
  let delivered;
  try {
    delivered = await deliverStoredOperation(context, entry);
  } catch {
    throw new CliError(
      "Capability report delivery is unavailable; the durable entry was preserved.",
      75,
    );
  }
  testCrash("after-report-send");
  if (delivered.response.status === 201) {
    const report = parseCapabilityReportResponse(
      delivered.payload,
      entry.reportId,
    );
    await transitionOperation(stateDir, entry, "acked", {
      status: delivered.response.status,
      body: delivered.body,
    });
    return {
      ...report,
      replay: delivered.response.headers.get("x-nexus-replay") === "1",
    };
  }
  if (
    delivered.response.status >= 500 ||
    delivered.response.status === 429 ||
    (delivered.response.status === 409 &&
      delivered.payload?.error === "nonce_reused")
  ) {
    throw new CliError(
      "Capability report delivery is retryable; the durable entry was preserved.",
      75,
    );
  }
  await transitionOperation(
    stateDir,
    entry,
    terminalOutboxStatus(delivered.response, delivered.payload),
    {
      status: delivered.response.status,
      body: delivered.body,
    },
  );
  throw capabilityReportHttpError(
    delivered.response,
    delivered.payload,
  );
}

async function deliverStoredOperation(context, entry) {
  if (entry.v === 3) {
    throw new CliError(
      "Declaration delivery is not enabled in this runner version.",
      76,
    );
  }
  const domain =
    entry.kind === "lease.claim"
      ? "nexus-runner-lease-claim-v1"
      : entry.kind === "run.complete"
        ? "nexus-runner-run-complete-v1"
        : "nexus-runner-capability-report-v1";
  const pathname = deriveOutboxPathname(entry);
  const response = await signedRequest({
    audience: context.audience,
    pathname,
    domain,
    body: operationBody(entry),
    privateKey: context.privateKey,
    publicKey: context.publicKey,
    keyId: context.state.runnerId,
  });
  const body = await readBoundedResponse(response);
  let payload = {};
  try {
    payload = JSON.parse(body);
  } catch {
    if (response.ok) {
      throw new CliError("NexusOS returned an invalid run response.", 76);
    }
  }
  return { response, body, payload };
}

function parseCapabilityReportResponse(value, reportId) {
  if (
    value?.reportId !== reportId ||
    typeof value?.receivedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      value.receivedAt,
    ) ||
    !Number.isFinite(Date.parse(value.receivedAt)) ||
    new Date(Date.parse(value.receivedAt)).toISOString() !== value.receivedAt
  ) {
    throw new CliError(
      "NexusOS returned an invalid capability report response.",
      76,
    );
  }
  return value;
}

function capabilityReportHttpError(response, payload) {
  if (response.status === 401 || response.status === 403) {
    return new CliError(
      "Capability report authentication was rejected. Inspect or revoke this runner.",
      77,
    );
  }
  if (
    response.status === 409 &&
    payload?.error === "report_conflict"
  ) {
    return new CliError(
      "Capability report identity conflicts with durable server history.",
      75,
    );
  }
  if (response.status === 410) {
    return new CliError(
      "Capability report exceeded the durable replay horizon.",
      75,
    );
  }
  return new CliError(
    `Capability report failed with HTTP ${response.status}.`,
    75,
  );
}

async function holdDiagnosticLease(context, claim) {
  const startedAt = Date.now();
  const holdMs = diagnosticHoldMs();
  const renewalMs = diagnosticRenewalMs();
  let canceled = Boolean(claim.cancelRequested);
  for (
    let nextRenewal = renewalMs;
    !canceled && nextRenewal < holdMs;
    nextRenewal += renewalMs
  ) {
    const waitMs = startedAt + nextRenewal - Date.now();
    if (waitMs > 0) {
      await interruptibleDelay(waitMs, new AbortController().signal);
    }
    const pathname = `/api/runs/${claim.runId}/lease/renew`;
    const body = Buffer.from(
      canonicalJson({ fence: claim.fence, leaseId: claim.leaseId }),
      "utf8",
    );
    let response;
    try {
      response = await signedRequest({
        audience: context.audience,
        pathname,
        domain: "nexus-runner-lease-renew-v1",
        body,
        privateKey: context.privateKey,
        publicKey: context.publicKey,
        keyId: context.state.runnerId,
      });
    } catch {
      process.stderr.write(
        "nexus-runner: lease renewal unavailable; completion remains fenced.\n",
      );
      continue;
    }
    const responseBody = await readBoundedResponse(response);
    let payload;
    try {
      payload = JSON.parse(responseBody);
    } catch {
      throw new CliError("NexusOS returned an invalid renewal response.", 76);
    }
    if (!response.ok) throw runHttpError("Lease renewal", response, payload);
    canceled = Boolean(payload.cancelRequested);
  }
  const remaining = startedAt + holdMs - Date.now();
  if (!canceled && remaining > 0) {
    await interruptibleDelay(remaining, new AbortController().signal);
  }
  return canceled;
}

function latestClaim(entries, runId) {
  return entries
    .filter(
      (entry) =>
        entry.kind === "lease.claim" &&
        entry.runId === runId &&
        entry.status === "acked",
    )
    .at(-1);
}

function storedClaim(entry) {
  if (!entry?.response) return undefined;
  try {
    return parseClaim(
      JSON.parse(
        Buffer.from(entry.response.bodyBase64, "base64url").toString("utf8"),
      ),
      entry.runId,
    );
  } catch {
    return undefined;
  }
}

function parseClaim(value, runId) {
  if (
    value?.runId !== runId ||
    !/^lse_[0-9a-f]{32}$/u.test(value?.leaseId ?? "") ||
    !Number.isSafeInteger(value?.fence) ||
    value.fence < 1 ||
    typeof value?.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value?.cancelRequested !== "boolean"
  ) {
    throw new CliError("NexusOS returned an invalid lease response.", 76);
  }
  return value;
}

function parseCompletion(value, runId) {
  if (
    value?.runId !== runId ||
    value?.status !== "completed" ||
    typeof value?.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt)) ||
    typeof value?.late !== "boolean"
  ) {
    throw new CliError("NexusOS returned an invalid completion response.", 76);
  }
  return value;
}

async function pendingEngineCompletion(context, stateDir, entry) {
  if (
    !isOutboxEntry(entry) ||
    entry.v !== 3 ||
    entry.declarationKind !== "engine.complete" ||
    entry.status !== "pending" ||
    !RUNNER_ID_PATTERN.test(context?.state?.runnerId ?? "") ||
    !validEngineCompletionContext(context)
  ) {
    throw new OutboxError("The pending engine completion is invalid.");
  }
  let storedText;
  try {
    storedText = await readFile(
      join(
        stateDir,
        OUTBOX_V3_DIRECTORY,
        `${entry.operationId}.json`,
      ),
      "utf8",
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new OutboxError("The pending engine completion is invalid.");
    }
    throw error;
  }
  const stored = parseOutboxEntryText(storedText);
  if (
    !stored ||
    stored.v !== 3 ||
    stored.declarationKind !== "engine.complete" ||
    stored.status !== "pending" ||
    stored.entrySha256 !== entry.entrySha256
  ) {
    throw new OutboxError("The pending engine completion is invalid.");
  }
  const body = operationBody(stored);
  const completion = parseEngineCompleteBody(body);
  if (
    !completion ||
    completion.operationId !== stored.operationId ||
    !RUN_ID_PATTERN.test(stored.runId)
  ) {
    throw new OutboxError("The pending engine completion is invalid.");
  }
  return Object.freeze({ body, entry: stored });
}

function validEngineCompletionContext(context) {
  if (
    !RUNNER_ID_PATTERN.test(context?.state?.runnerId ?? "") ||
    context?.state?.audience !== context?.audience ||
    typeof context?.audience !== "string" ||
    typeof context?.publicKey !== "string" ||
    !TOKEN_PATTERN.test(context.publicKey) ||
    !context?.privateKey
  ) {
    return false;
  }
  try {
    return (
      normalizeAudience(context.audience) === context.audience &&
      rawPublicKey(context.privateKey) === context.publicKey
    );
  } catch {
    return false;
  }
}

function classifiedEngineCompleteServerError(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof payload.error === "string" &&
    ENGINE_COMPLETE_SERVER_ERRORS.has(payload.error)
  )
    ? payload.error
    : null;
}

function engineCompletionDeliveryError(entry, details) {
  return new EngineCompletionDeliveryError({
    ...details,
    exitCodeHint:
      details.code === "auth"
        ? 77
        : details.code === "protocol"
          ? 76
          : 75,
    operationId: entry.operationId,
    runId: entry.runId,
  });
}

function completionDeliveryOutcome(error) {
  return Object.freeze({
    code: error.code,
    httpStatus: error.httpStatus,
    operationId: error.operationId,
    runId: error.runId,
    serverError: error.serverError,
  });
}

function engineCompletionErrorMessage(code) {
  if (code === "auth") {
    return "Engine completion authentication was rejected.";
  }
  if (code === "protocol") {
    return "Engine completion response violated the protocol.";
  }
  if (code === "retryable") {
    return "Engine completion delivery is retryable.";
  }
  if (code === "superseded") {
    return "Engine completion lost fenced authority.";
  }
  return "Engine completion was rejected.";
}

function terminalOutboxStatus(response, payload) {
  if (response.status === 410) return "abandoned";
  if (
    response.status === 409 &&
    ["lease_superseded", "run_unavailable"].includes(payload?.error)
  ) {
    return "superseded";
  }
  return "rejected";
}

function retryableClaimResponse(response, payload) {
  return (
    response.status >= 500 ||
    response.status === 429 ||
    (response.status === 409 &&
      ["runner_busy", "runner_conflict", "conflict_retry"].includes(
        payload?.error,
      ))
  );
}

function runHttpError(label, response, payload) {
  const code = payload?.error;
  if (response.status === 401 || response.status === 403) {
    return new CliError(
      `${label} authentication was rejected. Inspect or revoke this runner.`,
      77,
    );
  }
  if (
    response.status === 409 &&
    ["lease_superseded", "run_unavailable"].includes(code)
  ) {
    return new CliError(
      `${label} lost its fenced authority (${code}).`,
      75,
    );
  }
  if (
    response.status === 409 &&
    ["runner_busy", "runner_conflict", "conflict_retry"].includes(code)
  ) {
    return new CliError(
      `${label} is retryable (${code}); the durable outbox entry remains pending.`,
      75,
    );
  }
  if (response.status === 410) {
    if (code === "lease_expired") {
      return new CliError(
        `${label} expired; completion remains fenced and may still be accepted before reassignment.`,
        75,
      );
    }
    return new CliError(
      `${label} exceeded the durable replay horizon.`,
      75,
    );
  }
  return new CliError(
    `${label} failed with HTTP ${response.status}; the outbox entry was preserved.`,
    75,
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

function retryDelay(attempt) {
  const cap = Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6));
  return Math.max(100, Math.floor(Math.random() * cap));
}

function diagnosticHoldMs() {
  return testDuration("NEXUS_RUNNER_TEST_HOLD_MS", DIAGNOSTIC_HOLD_MS);
}

function diagnosticRenewalMs() {
  return testDuration(
    "NEXUS_RUNNER_TEST_RENEW_MS",
    LEASE_RENEW_INTERVAL_MS,
  );
}

function testDuration(name, fallback) {
  if (process.env.NEXUS_RUNNER_TEST !== "1") return fallback;
  const value = process.env[name];
  return value && /^\d{1,5}$/u.test(value) && Number(value) >= 10
    ? Number(value)
    : fallback;
}

function testCrash(boundary) {
  if (
    process.env.NEXUS_RUNNER_TEST === "1" &&
    process.env.NEXUS_RUNNER_TEST_CRASH === boundary
  ) {
    process.stderr.write(`nexus-runner: test crash at ${boundary}.\n`);
    process.exit(86);
  }
}

function reportCorruptEntry(event) {
  process.stderr.write(
    `nexus-runner: quarantined corrupt outbox entry ${event.file} as ${event.quarantinedAs}.\n`,
  );
}

function rawPublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  if (
    spki.byteLength !== PUBLIC_KEY_PREFIX.byteLength + 32 ||
    !spki.subarray(0, PUBLIC_KEY_PREFIX.byteLength).equals(PUBLIC_KEY_PREFIX)
  ) {
    throw new CliError("The local identity is not an Ed25519 key.", 78);
  }
  return spki.subarray(PUBLIC_KEY_PREFIX.byteLength).toString("base64url");
}

async function createStagedIdentity(keyPath) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const bytes = privateKey.export({ type: "pkcs8", format: "der" });
  try {
    await writeFile(keyPath, bytes, { flag: "wx", mode: 0o600 });
    await chmod(keyPath, 0o600);
    return { privateKey, created: true };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { privateKey: await readPrivateKey(keyPath), created: false };
    }
    throw error;
  }
}

async function readPrivateKey(keyPath) {
  const metadata = await secureRegularFile(keyPath, "runner private key");
  if ((metadata.mode & 0o077) !== 0) {
    throw new CliError(
      "Runner private key permissions are unsafe; expected mode 0600.",
      78,
    );
  }
  try {
    return createPrivateKey({
      key: await readFile(keyPath),
      type: "pkcs8",
      format: "der",
    });
  } catch {
    throw new CliError("Runner private key is invalid.", 78);
  }
}

async function ensureStateDirectory(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const metadata = await lstat(stateDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CliError("Runner state path must be a real directory.", 73);
  }
  await chmod(stateDir, 0o700);
}

async function acquireEnrollmentLock(lockPath) {
  try {
    await writeFile(lockPath, `${process.pid}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CliError(
        "Another enrollment is using this state directory.",
        73,
      );
    }
    throw error;
  }
  return async () => {
    await unlink(lockPath).catch(() => undefined);
  };
}

async function writeState(configPath, state) {
  const temporary = `${configPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await link(temporary, configPath);
    await chmod(configPath, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readState(configPath) {
  const metadata = await secureRegularFile(configPath, "runner state");
  if ((metadata.mode & 0o077) !== 0) {
    throw new CliError("Runner state permissions are unsafe; expected mode 0600.", 78);
  }
  let state;
  try {
    state = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new CliError("Runner state is invalid.", 78);
  }
  if (
    state?.version !== STATE_VERSION ||
    !RUNNER_ID_PATTERN.test(state.runnerId ?? "") ||
    !PRINCIPAL_ID_PATTERN.test(state.principalId ?? "") ||
    typeof state.organizationId !== "string" ||
    typeof state.displayName !== "string" ||
    typeof state.publicKey !== "string" ||
    typeof state.audience !== "string" ||
    normalizeAudience(state.audience) !== state.audience
  ) {
    throw new CliError("Runner state is invalid.", 78);
  }
  return state;
}

async function secureRegularFile(path, label) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CliError(`The ${label} must be a regular file.`, 78);
    }
    return metadata;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CliError(
        `No enrolled runner exists here. Run "enroll" first.`,
        66,
      );
    }
    throw error;
  }
}

function stateDirectory(options) {
  const configured = optionalOption(options, "state-dir");
  return resolve(configured ?? join(homedir(), ".nexusos", "runner"));
}

function statePaths(stateDir) {
  return {
    key: join(stateDir, "identity.pk8"),
    config: join(stateDir, "runner.json"),
    lock: join(stateDir, "enroll.lock"),
  };
}

async function readEnrollmentToken(fromStdin) {
  if (fromStdin && !process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk.toString("utf8");
      if (value.length > 1_024) {
        throw new CliError("Enrollment token input is too large.", 64);
      }
    }
    return value.trim();
  }
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new CliError(
      "Use --token-stdin for piped input; token arguments and token environment variables are intentionally unsupported.",
      64,
    );
  }
  process.stderr.write("Enrollment token: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolveToken, rejectToken) => {
    let token = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      process.stdin.off("data", onData);
      resolveToken(token);
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write("\n");
          process.stdin.off("data", onData);
          rejectToken(new CliError("Enrollment cancelled.", 130));
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          return;
        }
        if (byte === 127 || byte === 8) {
          token = token.slice(0, -1);
        } else if (byte >= 32 && byte <= 126 && token.length <= 1_024) {
          token += String.fromCharCode(byte);
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

function isCanonicalToken(token) {
  if (!TOKEN_PATTERN.test(token)) return false;
  try {
    const decoded = Buffer.from(token, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === token;
  } catch {
    return false;
  }
}

function normalizeAudience(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("--server must be an absolute NexusOS URL.", 64);
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new CliError(
      "--server must be an HTTPS origin (HTTP is allowed only for loopback development).",
      64,
    );
  }
  return url.origin;
}

async function readBoundedResponse(response) {
  return (await readBoundedResponseBytes(response)).toString("utf8");
}

async function readBoundedResponseBytes(response) {
  const limit = 64 * 1_024;
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) {
    throw new CliError("NexusOS response exceeds the runner limit.", 76);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CliError("NexusOS response exceeds the runner limit.", 76);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function parseEnrollment(body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new CliError("NexusOS returned an invalid enrollment response.", 76);
  }
  if (
    !RUNNER_ID_PATTERN.test(value?.runnerId ?? "") ||
    !PRINCIPAL_ID_PATTERN.test(value?.principalId ?? "") ||
    typeof value?.organizationId !== "string" ||
    typeof value?.enrolledAt !== "string" ||
    value?.trustProfile !== "operator_trust"
  ) {
    throw new CliError("NexusOS returned an invalid enrollment response.", 76);
  }
  return value;
}

function isDefinitiveEnrollmentRejection(status) {
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

async function removeStagedIdentity(keyPath) {
  await unlink(keyPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--") || value === "--") {
      throw new CliError("Unexpected positional argument.", 64);
    }
    const name = value.slice(2);
    if (
      name === "token" ||
      name.startsWith("token=") ||
      name === "enrollment-token" ||
      name.startsWith("enrollment-token=")
    ) {
      throw new CliError(
        "Token arguments are intentionally unsupported.",
        64,
      );
    }
    if (name === "token-stdin" || name === "dry-run") {
      if (parsed[name]) throw new CliError(`Duplicate option: --${name}`, 64);
      parsed[name] = true;
      continue;
    }
    if (parsed[name] !== undefined) {
      throw new CliError("A command option was provided more than once.", 64);
    }
    const optionValue = values[index + 1];
    if (!optionValue || optionValue.startsWith("--")) {
      throw new CliError("A command option is missing its value.", 64);
    }
    parsed[name] = optionValue;
    index += 1;
  }
  return parsed;
}

function assertOnlyOptions(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) {
      throw new CliError("Unsupported command option.", 64);
    }
  }
}

function requiredOption(options, name) {
  const value = optionalOption(options, name);
  if (!value) throw new CliError(`Missing required option: --${name}`, 64);
  return value;
}

function requiredEngine(options) {
  const engine = requiredOption(options, "engine");
  if (!ENGINE_NAMES.includes(engine)) {
    throw new CliError(
      "--engine must name claude_code_cli or codex_cli.",
      64,
    );
  }
  return engine;
}

function optionalOption(options, name) {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function pathExists(path) {
  return lstat(path)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
}

function interruptibleDelay(milliseconds, signal) {
  return new Promise((resolveDelay) => {
    if (signal.aborted) {
      resolveDelay();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function printHelp() {
  process.stdout.write(`NexusOS reference runner ${CLI_VERSION}

Usage:
  nexus-runner enroll --server <origin> --name <name> [--token-stdin] [--state-dir <path>]
  nexus-runner heartbeat [--server <origin>] [--state-dir <path>]
  nexus-runner report-capabilities [--server <origin>] [--state-dir <path>]
  nexus-runner report-capabilities --dry-run
  nexus-runner run [--server <origin>] [--interval-seconds <10..300>] [--state-dir <path>]
  nexus-runner serve [--server <origin>] [--interval-seconds <10..300>] [--state-dir <path>] [--run <run_id> --engine <claude_code_cli|codex_cli>]
  nexus-runner diagnose --run <run_id> [--server <origin>] [--state-dir <path>]
  nexus-runner outbox [--state-dir <path>]
  nexus-runner engines set --engine <claude_code_cli|codex_cli> --path <absolute> [--state-dir <path>]
  nexus-runner engines remove --engine <claude_code_cli|codex_cli> [--state-dir <path>]
  nexus-runner engines inspect [--state-dir <path>]
  nexus-runner engines report [--server <origin>] [--state-dir <path>] [--dry-run]

Engine binaries and every resolved parent directory must be owned by root or
the operator and must not be group/world writable. A group-writable macOS
/Applications path intentionally fails closed; place the CLI in a private
operator-owned location instead. Probe commands use a temporary private 0700
directory beside the runner state directory, remove it after each snapshot
and sweep a bounded set of stale crash remnants under the state lock.

Enrollment secrets are accepted only through a hidden TTY prompt or standard
input with --token-stdin. They are never accepted as arguments or environment
variables. Identity, heartbeat, signed host-declared capability reporting and
the fixed diagnostic lease/replay flow are implemented. The serve command
adds concurrent heartbeat and durable engine-completion recovery. With an
explicit --run/--engine pair it processes exactly that one analysis-only
target through the locally authenticated provider CLI; it never polls for
ambient work. Provider authentication remains local OAuth/CLI state. Capability reporting
uses bounded static local self-probes, remains host-declared and is not
verified by NexusOS. The Node Permission Model is reported only as a filesystem
guardrail, never as a sandbox. Tool presence does not prove isolation.
Workspace-mutating execution, streaming and general-purpose tool use are not
part of this runner version. Set NEXUS_RUNNER_DISABLE_PROBES=1 to report the conservative
all-unknown baseline.
`);
}
