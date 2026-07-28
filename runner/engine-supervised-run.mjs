import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  finalizeAttemptRecord,
  validateAttemptRecordSet,
} from "./attempt-journal-contract.mjs";
import {
  normalizeEngineExecutableFingerprint,
} from "./engine-executable-identity.mjs";
import {
  persistAttemptRecord,
} from "./attempt-journal-store.mjs";
import {
  SUPERVISOR_BOOTSTRAP_MAX_BYTES,
  SUPERVISOR_EVENT_MAX_BYTES,
  SUPERVISOR_HANDSHAKE_TIMEOUT_MS,
  SUPERVISOR_PROTOCOL_VERSION,
  createSupervisorPrestartReceipt,
  encodeSupervisorControl,
  encodeSupervisorStartToken,
  parseSupervisorBootstrap,
  parseSupervisorEvent,
  parseSupervisorStartToken,
  supervisorFaultReason,
  verifySupervisorChildEvent,
  verifySupervisorHelloAck,
} from "./engine-supervisor-protocol.mjs";

const SUPERVISOR_MODULE = new URL(
  "./engine-supervisor-child.mjs",
  import.meta.url,
);
const SCRATCH_DIRECTORY = "engine-scratch-v1";
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export class SupervisedRunError extends Error {
  constructor(message, code = "supervisor_invalid", cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "SupervisedRunError";
    this.code = code;
  }
}

/*
 * These wrappers intentionally are not async. They copy caller-owned prompt
 * bytes before returning control, closing the mutation window before the first
 * await in the implementation.
 */
export function runSupervisedAttempt(input) {
  const captured = captureInitialAttempt(input);
  return startCapturedAttempt(captured).finally(() => {
    captured.ownedInput.fill(0);
  });
}

export function resumeSupervisedAttempt(input) {
  const captured = captureResumableAttempt(input);
  return resumeCapturedAttempt(captured).finally(() => {
    captured.ownedInput?.fill(0);
  });
}

async function startCapturedAttempt(context) {
  const {
    appendRecord,
    records,
    spawnSupervisor = spawnSupervisorProcess,
    stateDir,
  } = context;
  await ensurePrivateScratchRoot(stateDir);
  const supervisor = await spawnSupervisor();
  let supervisorPersisted = false;
  try {
    const bootstrap = await readBootstrap(supervisor);
    if (bootstrap.pid !== supervisor.pid) {
      throw new SupervisedRunError(
        "Supervisor bootstrap identity is invalid.",
      );
    }
    const supervisorRecord = finalizeAttemptRecord({
      attemptId: records.claimed.attemptId,
      createdAt: maxIso(
        new Date().toISOString(),
        records.starting.createdAt,
      ),
      state: "supervisor",
      supervisorPid: bootstrap.pid,
      supervisorStartToken: encodeSupervisorStartToken(
        bootstrap.port,
        bootstrap.token,
      ),
      v: 1,
    });
    context.records = await appendRecord(supervisorRecord);
    supervisorPersisted = true;
    supervisor.unref?.();
    const session = await openAuthenticatedSession(
      supervisorRecord.supervisorStartToken,
      records.claimed.attemptId,
    );
    return await driveAuthenticatedSupervisor({
      ...context,
      session,
    });
  } catch (error) {
    if (!supervisorPersisted) {
      if (
        supervisor.exitCode === null &&
        supervisor.signalCode === null
      ) {
        supervisor.kill?.("SIGTERM");
      }
    }
    throw error;
  } finally {
    supervisor.stdout?.destroy();
  }
}

async function resumeCapturedAttempt(context) {
  const { records, stateDir } = context;
  await ensurePrivateScratchRoot(stateDir);
  if (records.result || records.outboxed) {
    await acknowledgeRecoveredTerminal(records).catch(() => undefined);
    return records;
  }
  const session = await openAuthenticatedSession(
    records.supervisor.supervisorStartToken,
    records.claimed.attemptId,
  );
  return driveAuthenticatedSupervisor({ ...context, session });
}

async function driveAuthenticatedSupervisor(context) {
  const {
    appendRecord,
    binaryFingerprint,
    cancelSignal,
    detachSignal,
    executableRealPath,
    ownedInput,
    session,
    stateDir,
  } = context;
  let { records } = context;
  let event = session.event;
  const cancellation = { sent: false };
  try {
    while (true) {
      if (
        ["waiting_spawn", "waiting_input", "running"].includes(
          event.state,
        ) &&
        cancelSignal?.aborted &&
        !cancellation.sent
      ) {
        await sendSupervisorCancel(
          session,
          records.claimed.attemptId,
          cancellation,
          terminationReason(cancelSignal),
        );
        event = await session.next();
        continue;
      }
      if (detachSignal?.aborted && !cancelSignal?.aborted) {
        throw new SupervisedRunError(
          "Supervisor control detached.",
          "supervisor_detached",
        );
      }
      if (event.state === "waiting_spawn") {
        if (records.started || records.result) {
          throw new SupervisedRunError(
            "Supervisor regressed before spawn.",
          );
        }
        if (
          !binaryFingerprint ||
          !ownedInput ||
          typeof executableRealPath !== "string"
        ) {
          throw new SupervisedRunError(
            "Recovery requires the committed prompt and executable.",
            "supervisor_input_unavailable",
          );
        }
        const spawnFrame = {
          attemptId: records.claimed.attemptId,
          kind: "authorize_spawn",
          request: {
            cwdRoot: join(stateDir, SCRATCH_DIRECTORY),
            deadlineAt: records.starting.deadlineAt,
            engine: records.starting.engine,
            engineVersion: records.starting.engineVersion,
            binaryFingerprint,
            executableRealPath,
            inputBase64: ownedInput.toString("base64url"),
            inputSha256: records.starting.promptSha256,
            timeoutMs: records.starting.timeoutMs,
          },
          token: session.token,
          v: SUPERVISOR_PROTOCOL_VERSION,
        };
        await session.send(spawnFrame);
        ownedInput.fill(0);
        spawnFrame.request.inputBase64 = "";
        event = await nextSupervisorEvent({
          attemptId: records.claimed.attemptId,
          cancellation,
          cancelSignal,
          detachSignal,
          session,
        });
        continue;
      }
      if (event.state === "waiting_input" || event.state === "running") {
        if (
          !verifySupervisorChildEvent(session.token, event) ||
          event.startedAt < records.supervisor.createdAt
        ) {
          throw new SupervisedRunError(
            "Supervisor child identity is invalid.",
          );
        }
        records = await appendOrVerifyStartedRecord(
          appendRecord,
          records,
          event,
        );
        if (event.state === "waiting_input") {
          await session.send({
            attemptId: records.claimed.attemptId,
            childToken: event.childToken,
            kind: "authorize_input",
            token: session.token,
            v: SUPERVISOR_PROTOCOL_VERSION,
          });
        }
        event = await nextSupervisorEvent({
          attemptId: records.claimed.attemptId,
          cancellation,
          cancelSignal,
          detachSignal,
          session,
        });
        continue;
      }
      if (event.state === "result") {
        records = await appendOrVerifyResultRecord(
          appendRecord,
          records,
          event.receipt,
        );
        await acknowledgeDurableResult(
          records.supervisor.supervisorStartToken,
          records.claimed.attemptId,
          session,
        );
        return records;
      }
      if (event.state === "fault") {
        records = await persistFaultResult(
          appendRecord,
          records,
          event,
        );
        await abandonAfterDurableFault(
          records.supervisor.supervisorStartToken,
          records.claimed.attemptId,
          session,
        );
        return records;
      }
      throw new SupervisedRunError("Supervisor state is invalid.");
    }
  } catch (error) {
    session.close();
    throw error;
  }
}

export async function inspectSupervisedAttempt(
  supervisorStartToken,
  attemptId,
) {
  if (!parseSupervisorStartToken(supervisorStartToken)) {
    return Object.freeze({ status: "ambiguous" });
  }
  try {
    const session = await openAuthenticatedSession(
      supervisorStartToken,
      attemptId,
    );
    const outcome = Object.freeze({
      event: session.event,
      status: "matching",
    });
    session.close();
    return outcome;
  } catch {
    // Refused ports and failed proofs are ambiguous; neither proves that a
    // previously supervised engine process group is absent.
    return Object.freeze({ status: "ambiguous" });
  }
}

export async function abandonSupervisedAttempt(
  supervisorStartToken,
  attemptId,
) {
  if (!parseSupervisorStartToken(supervisorStartToken)) {
    return Object.freeze({ status: "ambiguous" });
  }
  try {
    const session = await openAuthenticatedSession(
      supervisorStartToken,
      attemptId,
    );
    await session.send({
      attemptId,
      kind: "abandon",
      token: session.token,
      v: SUPERVISOR_PROTOCOL_VERSION,
    });
    await session.waitForClose();
    return Object.freeze({ status: "requested" });
  } catch {
    return Object.freeze({ status: "ambiguous" });
  }
}

async function appendOrVerifyStartedRecord(
  appendRecord,
  records,
  event,
) {
  const candidate = finalizeAttemptRecord({
    attemptId: records.claimed.attemptId,
    childPid: event.childPid,
    childStartToken: event.childToken,
    createdAt: maxIso(
      new Date().toISOString(),
      records.supervisor.createdAt,
      event.startedAt,
    ),
    startedAt: event.startedAt,
    state: "started",
    v: 1,
  });
  if (records.started) {
    if (
      records.started.childPid !== candidate.childPid ||
      records.started.childStartToken !== candidate.childStartToken ||
      records.started.startedAt !== candidate.startedAt
    ) {
      throw new SupervisedRunError(
        "Supervisor child identity changed.",
      );
    }
    return records;
  }
  return appendRecord(candidate);
}

async function appendOrVerifyResultRecord(
  appendRecord,
  records,
  receipt,
) {
  if (
    receipt.engine !== records.starting.engine ||
    receipt.engineVersion !== records.starting.engineVersion ||
    (records.started
      ? receipt.startedAt !== records.started.startedAt
      : receipt.reason !== "spawn_failed")
  ) {
    throw new SupervisedRunError("Supervisor result is invalid.");
  }
  if (records.result) {
    if (canonicalJson(records.result.receipt) !== canonicalJson(receipt)) {
      throw new SupervisedRunError("Supervisor result changed.");
    }
    return records;
  }
  const resultRecord = finalizeAttemptRecord({
    attemptId: records.claimed.attemptId,
    createdAt: maxIso(
      new Date().toISOString(),
      records.supervisor.createdAt,
      records.started?.createdAt,
      receipt.finishedAt,
    ),
    receipt,
    state: "result",
    v: 1,
  });
  return appendRecord(resultRecord);
}

async function persistFaultResult(appendRecord, records, event) {
  const reason = supervisorFaultReason(
    records.started ? "running" : "waiting_spawn",
    event.code,
  );
  const recordedAt = maxIso(
    new Date().toISOString(),
    records.supervisor.createdAt,
    records.started?.createdAt,
  );
  const receipt = records.started
    ? {
        cancelRequested: reason === "cancel_requested",
        engine: records.starting.engine,
        engineVersion: records.starting.engineVersion,
        exitCode: null,
        finishedAt: recordedAt,
        reason,
        startedAt: records.started.startedAt,
        status: reason === "cancel_requested" ? "canceled" : "failed",
        stderr: emptyStream(),
        stdout: emptyStream(),
        summary: reason,
        timedOut: reason === "timed_out",
      }
    : createSupervisorPrestartReceipt({
        engine: records.starting.engine,
        engineVersion: records.starting.engineVersion,
        recordedAt,
        reason,
      });
  return appendOrVerifyResultRecord(appendRecord, records, receipt);
}

async function nextSupervisorEvent({
  attemptId,
  cancellation,
  cancelSignal,
  detachSignal,
  session,
}) {
  const pending = session.next();
  pending.catch(() => undefined);
  const events = [
    pending.then((event) => ({ event, kind: "event" })),
  ];
  const abortWaits = [];
  if (!cancellation.sent && cancelSignal) {
    const cancelWait = createAbortWait(cancelSignal, "cancel");
    abortWaits.push(cancelWait);
    events.push(cancelWait.promise);
  }
  if (detachSignal && !cancelSignal?.aborted) {
    const detachWait = createAbortWait(detachSignal, "detach");
    abortWaits.push(detachWait);
    events.push(detachWait.promise);
  }
  let selected;
  try {
    selected = await Promise.race(events);
  } finally {
    for (const wait of abortWaits) wait.dispose();
  }
  if (selected.kind === "event") return selected.event;
  if (selected.kind === "cancel") {
    await sendSupervisorCancel(
      session,
      attemptId,
      cancellation,
      terminationReason(cancelSignal),
    );
    return pending;
  }
  session.close();
  throw new SupervisedRunError(
    "Supervisor control detached.",
    "supervisor_detached",
  );
}

async function sendSupervisorCancel(
  session,
  attemptId,
  cancellation,
  reason,
) {
  if (cancellation.sent) return;
  cancellation.sent = true;
  await session.send({
    attemptId,
    kind: "terminate",
    reason,
    token: session.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
}

function terminationReason(signal) {
  return [
    "cancel_requested",
    "engine_deadline_exhausted",
    "engine_incompatible",
    "lease_lost",
    "prompt_erased",
    "prompt_integrity_mismatch",
    "prompt_unavailable",
  ].includes(signal?.reason)
    ? signal.reason
    : "cancel_requested";
}

function createAbortWait(signal, kind) {
  if (signal.aborted) {
    return Object.freeze({
      dispose() {},
      promise: Promise.resolve({ kind }),
    });
  }
  let listener;
  const promise = new Promise((resolveAbort) => {
    listener = () => resolveAbort({ kind });
    signal.addEventListener("abort", listener, { once: true });
  });
  return Object.freeze({
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
    },
    promise,
  });
}

async function acknowledgeDurableResult(
  startToken,
  attemptId,
  session,
) {
  try {
    await session.send({
      attemptId,
      kind: "ack_result",
      token: session.token,
      v: SUPERVISOR_PROTOCOL_VERSION,
    });
    await session.waitForClose();
    return;
  } catch {
    session.close();
  }
  try {
    const retry = await openAuthenticatedSession(startToken, attemptId);
    await retry.send({
      attemptId,
      kind: "ack_result",
      token: retry.token,
      v: SUPERVISOR_PROTOCOL_VERSION,
    });
    await retry.waitForClose();
  } catch {
    // The result is already durable. A refused endpoint may mean that the
    // first acknowledgement was processed, so cleanup remains best-effort.
  }
}

async function abandonAfterDurableFault(
  startToken,
  attemptId,
  session,
) {
  try {
    await session.send({
      attemptId,
      kind: "abandon",
      token: session.token,
      v: SUPERVISOR_PROTOCOL_VERSION,
    });
    await session.waitForClose();
    return;
  } catch {
    session.close();
  }
  await abandonSupervisedAttempt(startToken, attemptId);
}

async function acknowledgeRecoveredTerminal(records) {
  const session = await openAuthenticatedSession(
    records.supervisor.supervisorStartToken,
    records.claimed.attemptId,
  );
  if (!records.result) {
    session.close();
    return;
  }
  if (session.event.state === "waiting_input") {
    const replay = await session.next();
    if (replay.state !== "result") {
      session.close();
      return;
    }
  }
  await acknowledgeDurableResult(
    records.supervisor.supervisorStartToken,
    records.claimed.attemptId,
    session,
  );
}

async function openAuthenticatedSession(startToken, attemptId) {
  const identity = parseSupervisorStartToken(startToken);
  if (!identity || !/^att_[0-9a-f]{32}$/u.test(attemptId ?? "")) {
    throw new SupervisedRunError("Supervisor identity is invalid.");
  }
  const socket = createConnection({
    host: "127.0.0.1",
    port: identity.port,
  });
  socket.setNoDelay(true);
  try {
    await withTimeout(
      new Promise((resolveConnect, rejectConnect) => {
        socket.once("connect", resolveConnect);
        socket.once("error", rejectConnect);
      }),
    );
    const reader = createBoundedFrameQueue(
      socket,
      SUPERVISOR_EVENT_MAX_BYTES,
      3,
    );
    const nonce = randomBytes(16).toString("hex");
    await writeControl(socket, {
      attemptId,
      kind: "hello",
      nonce,
      v: SUPERVISOR_PROTOCOL_VERSION,
    });
    const acknowledgement = parseSupervisorEvent(
      await withTimeout(reader.next()),
    );
    if (
      !acknowledgement ||
      !verifySupervisorHelloAck(
        { attemptId, nonce, token: identity.token },
        acknowledgement,
      )
    ) {
      throw new SupervisedRunError("Supervisor challenge failed.");
    }
    await writeControl(socket, {
      attemptId,
      kind: "attach",
      token: identity.token,
      v: SUPERVISOR_PROTOCOL_VERSION,
    });
    const event = parseSupervisorEvent(
      await withTimeout(reader.next()),
    );
    if (!validStateEvent(event, attemptId)) {
      throw new SupervisedRunError("Supervisor state is invalid.");
    }
    return {
      event,
      token: identity.token,
      close() {
        reader.close();
        socket.destroy();
      },
      async next() {
        const next = parseSupervisorEvent(
          await withTimeout(reader.next(), 610_000),
        );
        if (!validStateEvent(next, attemptId)) {
          throw new SupervisedRunError("Supervisor state is invalid.");
        }
        return next;
      },
      send(frame) {
        return writeControl(socket, frame);
      },
      waitForClose() {
        return withTimeout(reader.closed(), 5_000);
      },
    };
  } catch (error) {
    socket.destroy();
    throw new SupervisedRunError(
      "Supervisor session failed.",
      "supervisor_ambiguous",
      error,
    );
  }
}

function captureInitialAttempt(input) {
  const records = validateAttemptRecordSet(
    input?.attempt?.records ?? input?.attempt,
  );
  const ownedInput = captureCommittedInput(records, input?.input, true);
  const binaryFingerprint =
    normalizeEngineExecutableFingerprint(input?.binaryFingerprint);
  if (
    !records ||
    !records.starting ||
    !records.spawning ||
    records.supervisor ||
    records.started ||
    records.result ||
    records.outboxed ||
    !binaryFingerprint ||
    typeof input?.executableRealPath !== "string" ||
    typeof input?.stateDir !== "string" ||
    !validOptionalSignal(input?.cancelSignal) ||
    !validOptionalSignal(input?.detachSignal) ||
    (
      input?.appendRecord !== undefined &&
      typeof input.appendRecord !== "function"
    )
  ) {
    ownedInput?.fill(0);
    throw new SupervisedRunError("Starting attempt is invalid.");
  }
  return {
    appendRecord:
      input.appendRecord ??
      ((record) => persistAttemptRecord(input.stateDir, record)),
    binaryFingerprint,
    cancelSignal: input.cancelSignal,
    detachSignal: input.detachSignal,
    executableRealPath: input.executableRealPath,
    ownedInput,
    records,
    spawnSupervisor: input.spawnSupervisor,
    stateDir: input.stateDir,
  };
}

function captureResumableAttempt(input) {
  const records = validateAttemptRecordSet(
    input?.attempt?.records ?? input?.attempt,
  );
  const ownedInput = captureCommittedInput(
    records,
    input?.input,
    false,
  );
  const binaryFingerprint =
    input?.binaryFingerprint === undefined
      ? undefined
      : normalizeEngineExecutableFingerprint(
          input.binaryFingerprint,
        );
  if (
    !records ||
    !records.starting ||
    !records.supervisor ||
    (
      input?.binaryFingerprint !== undefined &&
      !binaryFingerprint
    ) ||
    typeof input?.stateDir !== "string" ||
    !validOptionalSignal(input?.cancelSignal) ||
    !validOptionalSignal(input?.detachSignal) ||
    (
      input?.appendRecord !== undefined &&
      typeof input.appendRecord !== "function"
    )
  ) {
    ownedInput?.fill(0);
    throw new SupervisedRunError("Resumable attempt is invalid.");
  }
  return {
    appendRecord:
      input.appendRecord ??
      ((record) => persistAttemptRecord(input.stateDir, record)),
    binaryFingerprint,
    cancelSignal: input.cancelSignal,
    detachSignal: input.detachSignal,
    executableRealPath: input.executableRealPath,
    ownedInput,
    records,
    stateDir: input.stateDir,
  };
}

function validOptionalSignal(value) {
  return Boolean(
    value === undefined ||
    (
      value &&
      typeof value === "object" &&
      typeof value.aborted === "boolean" &&
      typeof value.addEventListener === "function"
    )
  );
}

function captureCommittedInput(records, input, required) {
  if (input === undefined && !required) return undefined;
  const bytes =
    input instanceof Uint8Array ? Buffer.from(input) : undefined;
  if (
    !records?.starting ||
    !bytes ||
    bytes.byteLength !== records.starting.promptBytes ||
    createHash("sha256").update(bytes).digest("hex") !==
      records.starting.promptSha256
  ) {
    bytes?.fill(0);
    throw new SupervisedRunError("Committed prompt is invalid.");
  }
  return bytes;
}

async function ensurePrivateScratchRoot(stateDir) {
  const root = join(stateDir, SCRATCH_DIRECTORY);
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const resolved = await realpath(root);
  const metadata = await lstat(resolved);
  if (
    resolved !== root ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.geteuid() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new SupervisedRunError("Supervisor scratch root is invalid.");
  }
  return root;
}

function spawnSupervisorProcess() {
  const home = process.env.HOME;
  if (!home || !home.startsWith("/")) {
    throw new SupervisedRunError("Supervisor environment is invalid.");
  }
  return spawn(
    process.execPath,
    [fileURLToPath(SUPERVISOR_MODULE), "--supervisor-v2"],
    {
      detached: true,
      env: {
        HOME: home,
        LANG: "C",
        LC_ALL: "C",
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        TERM: "dumb",
      },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
}

async function readBootstrap(supervisor) {
  if (
    !supervisor ||
    !Number.isSafeInteger(supervisor.pid) ||
    !supervisor.stdout
  ) {
    throw new SupervisedRunError("Supervisor spawn failed.");
  }
  const reader = createBoundedFrameQueue(
    supervisor.stdout,
    SUPERVISOR_BOOTSTRAP_MAX_BYTES,
    1,
  );
  try {
    const bootstrap = parseSupervisorBootstrap(
      await withTimeout(reader.next()),
    );
    if (!bootstrap) {
      throw new SupervisedRunError("Supervisor bootstrap is invalid.");
    }
    return bootstrap;
  } finally {
    reader.close();
  }
}

function createBoundedFrameQueue(stream, maximum, maximumFrames) {
  let buffered = Buffer.alloc(0);
  let closed = false;
  let failure;
  let queuedBytes = 0;
  const values = [];
  const waiters = [];
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const settle = () => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (values.length > 0) {
        const value = values.shift();
        queuedBytes -= value.byteLength;
        if (values.length < maximumFrames) stream.resume?.();
        waiter.resolve(value);
      } else if (failure) {
        waiter.reject(failure);
      } else {
        waiters.unshift(waiter);
        break;
      }
    }
  };
  const fail = (message) => {
    if (failure) return;
    failure = new SupervisedRunError(message);
    stream.destroy?.();
    settle();
  };
  const onData = (chunk) => {
    if (
      chunk.byteLength > maximum * (maximumFrames + 1) ||
      buffered.byteLength + queuedBytes + chunk.byteLength >
        maximum * (maximumFrames + 1)
    ) {
      fail("Supervisor frame queue is oversized.");
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    while (!failure) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.byteLength > maximum) {
          fail("Supervisor frame is oversized.");
        }
        break;
      }
      const frame = buffered.subarray(0, newline + 1);
      buffered = buffered.subarray(newline + 1);
      if (
        frame.byteLength > maximum ||
        values.length >= maximumFrames
      ) {
        fail("Supervisor frame queue is oversized.");
        break;
      }
      const copy = Buffer.from(frame);
      values.push(copy);
      queuedBytes += copy.byteLength;
      if (values.length >= maximumFrames) stream.pause?.();
      settle();
    }
  };
  const onClose = () => {
    if (closed) return;
    closed = true;
    if (buffered.byteLength > 0) {
      failure ??= new SupervisedRunError(
        "Supervisor connection ended with a partial frame.",
      );
    } else {
      failure ??= new SupervisedRunError(
        "Supervisor connection closed.",
      );
    }
    resolveClosed();
    settle();
  };
  stream.on("data", onData);
  stream.once("close", onClose);
  stream.once("end", onClose);
  stream.once("error", onClose);
  return {
    close() {
      stream.off("data", onData);
      stream.off("close", onClose);
      stream.off("end", onClose);
      stream.off("error", onClose);
      buffered.fill(0);
      buffered = Buffer.alloc(0);
      for (const value of values) value.fill(0);
      values.length = 0;
    },
    closed() {
      if (closed) return Promise.resolve();
      return closedPromise;
    },
    next() {
      if (values.length > 0) {
        const value = values.shift();
        queuedBytes -= value.byteLength;
        if (values.length < maximumFrames) stream.resume?.();
        return Promise.resolve(value);
      }
      if (failure) return Promise.reject(failure);
      return new Promise((resolveNext, rejectNext) => {
        waiters.push({ reject: rejectNext, resolve: resolveNext });
      });
    },
  };
}

function writeControl(socket, frame) {
  let bytes;
  try {
    bytes = encodeSupervisorControl(frame);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolveWrite, rejectWrite) => {
    const onError = (error) => {
      socket.off("error", onError);
      bytes.fill(0);
      rejectWrite(error);
    };
    socket.once("error", onError);
    socket.write(bytes, () => {
      socket.off("error", onError);
      bytes.fill(0);
      resolveWrite();
    });
  });
}

function withTimeout(promise, milliseconds = SUPERVISOR_HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(
      () => rejectTimeout(new SupervisedRunError("Supervisor timed out.")),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveTimeout(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectTimeout(error);
      },
    );
  });
}

function validStateEvent(event, attemptId) {
  return Boolean(
    event &&
      event.attemptId === attemptId &&
      event.kind === "state",
  );
}

function emptyStream() {
  return {
    bytes: 0,
    excerptBase64Url: "",
    sha256: EMPTY_SHA256,
    truncated: false,
  };
}

function maxIso(...values) {
  return values.filter(Boolean).sort().at(-1);
}

function canonicalJson(value) {
  if (value === undefined) throw new TypeError("Undefined is invalid.");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
