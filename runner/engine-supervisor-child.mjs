#!/usr/bin/env node

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createEngineExecutionProcessAdapter,
} from "./engine-adapters.mjs";
import {
  createEngineLaunchRecipe,
} from "./engine-launch-recipe.mjs";
import {
  parseEngineExecutionResult,
} from "./engine-complete-contract.mjs";
import {
  SUPERVISOR_CONTROL_MAX_BYTES,
  SUPERVISOR_HANDSHAKE_TIMEOUT_MS,
  SUPERVISOR_PROTOCOL_VERSION,
  encodeChildStartToken,
  encodeSupervisorBootstrap,
  encodeSupervisorEvent,
  parseSupervisorControl,
  supervisorChallengeProof,
} from "./engine-supervisor-protocol.mjs";

const ADDRESS = "127.0.0.1";
const MAX_CONNECTIONS = 8;
const STDERR_EXCERPT_BYTES = 512;
const STDOUT_EXCERPT_BYTES = 512;
const TERMINAL_HOLD_GRACE_MS = 300_000;
const TERMINAL_HOLD_MAX_MS = 1_800_000;
const WAITING_SPAWN_RECOVERY_HOLD_MS = TERMINAL_HOLD_MAX_MS;

if (isDirectExecution()) {
  if (process.argv.length !== 3 || process.argv[2] !== "--supervisor-v3") {
    process.exitCode = 64;
  } else {
    runSupervisor().catch(() => {
      process.exitCode = 1;
    });
  }
}

async function runSupervisor() {
  const token = randomBytes(16).toString("hex");
  let abandonRequested = false;
  let activeSocket;
  let attemptDeadlineAt;
  let attemptId;
  let childIdentityEvent;
  let controller;
  let currentEvent;
  let currentScratch;
  let executionPromise;
  let inputGate;
  let leaseExpired = false;
  let leaseExpiresAt;
  let leaseFence;
  let leaseId;
  let leaseTimer;
  let orphanTimer;
  let phase = "waiting_spawn";
  let protocolFault = false;
  let spawnAuthorized = false;
  let spawnRequestSha256;
  let terminalTimer;
  let terminationReason;
  const sockets = new Set();

  const server = createServer((socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    let authenticated = false;
    let challenged = false;
    let challengedAttemptId;
    const handshakeTimer = setTimeout(
      () => socket.destroy(),
      SUPERVISOR_HANDSHAKE_TIMEOUT_MS,
    );
    const stopReader = createBoundedFrameReader(
      socket,
      SUPERVISOR_CONTROL_MAX_BYTES,
      async (bytes) => {
        try {
          const frame = parseSupervisorControl(bytes);
          if (!frame) throw new Error("invalid");
          if (!challenged) {
            if (
              frame.kind !== "hello" ||
              (attemptId !== undefined && frame.attemptId !== attemptId)
            ) {
              throw new Error("invalid");
            }
            challenged = true;
            challengedAttemptId = frame.attemptId;
            writeEvent(socket, {
              attemptId: challengedAttemptId,
              kind: "hello_ack",
              nonce: frame.nonce,
              proof: supervisorChallengeProof(
                token,
                challengedAttemptId,
                frame.nonce,
              ),
              v: SUPERVISOR_PROTOCOL_VERSION,
            });
            return;
          }
          if (!authenticated) {
            if (
              frame.kind !== "attach" ||
              frame.attemptId !== challengedAttemptId ||
              !sameToken(frame.token, token) ||
              (activeSocket &&
                activeSocket !== socket &&
                !activeSocket.destroyed)
            ) {
              throw new Error("invalid");
            }
            attemptId ??= challengedAttemptId;
            authenticated = true;
            clearTimeout(handshakeTimer);
            clearTimeout(orphanTimer);
            activeSocket = socket;
            publishReconnectSnapshot(socket);
            return;
          }
          if (
            frame.attemptId !== attemptId ||
            !sameToken(frame.token, token)
          ) {
            throw new Error("invalid");
          }
          await handleAuthenticatedControl(frame);
        } finally {
          bytes.fill(0);
        }
      },
    );
    socket.once("close", () => {
      clearTimeout(handshakeTimer);
      stopReader();
      sockets.delete(socket);
      if (activeSocket === socket) activeSocket = undefined;
      if (phase === "waiting_spawn") armOrphanExit();
    });
    socket.once("error", () => undefined);
  });

  const handleAuthenticatedControl = async (frame) => {
    if (frame.kind === "authorize_spawn") {
      const fingerprint = requestFingerprint(frame.request);
      if (spawnAuthorized) {
        if (fingerprint !== spawnRequestSha256) {
          protocolFault = true;
          controller?.abort();
          inputGate?.resolve();
        }
        sendCurrent();
        return;
      }
      if (phase !== "waiting_spawn") throw new Error("invalid");
      spawnAuthorized = true;
      spawnRequestSha256 = fingerprint;
      attemptDeadlineAt = frame.request.deadlineAt;
      leaseFence = frame.request.fence;
      leaseId = frame.request.leaseId;
      if (!armLeaseHorizon(frame.request.expiresAt, true)) {
        terminationReason = "lease_lost";
        phase = "terminal";
        currentEvent = faultEvent(attemptId, terminationReason);
        armTerminalExit();
        sendCurrent();
        return;
      }
      phase = "spawning";
      executionPromise = executeAuthorizedRequest(frame.request);
      executionPromise.catch(() => undefined);
      return;
    }
    if (frame.kind === "extend_lease") {
      if (
        !spawnAuthorized ||
        phase === "terminal" ||
        frame.fence !== leaseFence ||
        frame.leaseId !== leaseId ||
        !armLeaseHorizon(frame.expiresAt, false)
      ) {
        throw new Error("invalid");
      }
      writeEvent(activeSocket, {
        attemptId,
        expiresAt: leaseExpiresAt,
        fence: leaseFence,
        kind: "lease_ack",
        leaseId,
        v: SUPERVISOR_PROTOCOL_VERSION,
      });
      return;
    }
    if (frame.kind === "authorize_input") {
      if (
        !childIdentityEvent ||
        frame.childToken !== childIdentityEvent.childToken
      ) {
        throw new Error("invalid");
      }
      if (phase === "waiting_input") {
        phase = "running";
        currentEvent = {
          ...childIdentityEvent,
          state: "running",
        };
        sendCurrent();
        inputGate?.resolve();
        inputGate = undefined;
        return;
      }
      if (phase === "running" || phase === "terminal") {
        sendCurrent();
        return;
      }
      throw new Error("invalid");
    }
    if (frame.kind === "terminate") {
      terminationReason ??= frame.reason;
      if (phase === "waiting_spawn") {
        phase = "terminal";
        currentEvent = faultEvent(attemptId, terminationReason);
        armTerminalExit();
        sendCurrent();
        return;
      }
      controller?.abort();
      inputGate?.resolve();
      inputGate = undefined;
      return;
    }
    if (frame.kind === "abandon") {
      abandonRequested = true;
      controller?.abort();
      inputGate?.resolve();
      inputGate = undefined;
      await executionPromise?.catch(() => undefined);
      await cleanupScratch();
      closeServer();
      return;
    }
    if (frame.kind === "ack_result") {
      if (phase !== "terminal" || currentEvent?.state !== "result") {
        throw new Error("invalid");
      }
      await cleanupScratch();
      closeServer();
    }
  };

  const executeAuthorizedRequest = async (request) => {
    let input;
    const executionFacts = {
      binaryFingerprint: request.binaryFingerprint,
      engine: request.engine,
      engineVersion: request.engineVersion,
      executableRealPath: request.executableRealPath,
      timeoutMs: request.timeoutMs,
    };
    try {
      const prepared = await prepareExecution({
        attemptId,
        request,
      });
      currentScratch = prepared.scratch;
      input = prepared.input;
      if (protocolFault) {
        input.fill(0);
        phase = "terminal";
        currentEvent = faultEvent(attemptId, "protocol_invalid");
        await cleanupScratch();
        armTerminalExit();
        sendCurrent();
        return;
      }
      if (terminationReason) {
        input.fill(0);
        phase = "terminal";
        currentEvent = faultEvent(attemptId, terminationReason);
        await cleanupScratch();
        armTerminalExit();
        sendCurrent();
        return;
      }
    } catch {
      input?.fill(0);
      phase = "terminal";
      currentEvent = faultEvent(attemptId, "spawn_failed");
      await cleanupScratch();
      armTerminalExit();
      sendCurrent();
      return;
    }

    let outcome;
    try {
      controller = new AbortController();
      const adapter = createEngineExecutionProcessAdapter();
      const recipe = createEngineLaunchRecipe({
        engine: executionFacts.engine,
        engineVersion: executionFacts.engineVersion,
        executableRealPath: executionFacts.executableRealPath,
        home: executionHome(),
        scratch: join(currentScratch, "cwd"),
      });
      const pendingOutcome = adapter.runBounded(
        {
          argv: recipe.argv,
          binaryFingerprint: executionFacts.binaryFingerprint,
          cwd: recipe.cwd,
          env: recipe.env,
          executableRealPath: executionFacts.executableRealPath,
          maxStderrBytes: 65_536,
          maxStdoutBytes: 262_144,
          signal: controller.signal,
          stdin: input,
          timeoutMs: executionFacts.timeoutMs,
        },
        {
          beforeInput({ childPid, startedAt }) {
            const childToken = encodeChildStartToken(token, 1);
            childIdentityEvent = {
              attemptId,
              childPid,
              childToken,
              kind: "state",
              startedAt,
              state: "waiting_input",
              v: SUPERVISOR_PROTOCOL_VERSION,
            };
            phase = "waiting_input";
            currentEvent = childIdentityEvent;
            sendCurrent();
            return new Promise((resolveInput, rejectInput) => {
              inputGate = {
                reject: rejectInput,
                resolve: resolveInput,
              };
            });
          },
        },
      );
      input.fill(0);
      outcome = await pendingOutcome;
    } catch {
      input.fill(0);
      phase = "terminal";
      currentEvent = faultEvent(
        attemptId,
        childIdentityEvent ? "protocol_invalid" : "spawn_failed",
      );
      await cleanupScratch();
      armTerminalExit();
      sendCurrent();
      return;
    }
    if (abandonRequested) {
      zeroOutcome(outcome);
      await cleanupScratch();
      return;
    }
    if (!outcome.startedAt) {
      zeroOutcome(outcome);
      phase = "terminal";
      currentEvent = faultEvent(attemptId, "spawn_failed");
      await cleanupScratch();
      armTerminalExit();
      sendCurrent();
      return;
    }
    if (protocolFault) {
      zeroOutcome(outcome);
      phase = "terminal";
      currentEvent = faultEvent(attemptId, "protocol_invalid");
      await cleanupScratch();
      armTerminalExit();
      sendCurrent();
      return;
    }
    try {
      currentEvent = {
        attemptId,
        kind: "state",
        receipt: executionReceipt(
          executionFacts,
          outcome,
          terminationReason,
        ),
        state: "result",
        v: SUPERVISOR_PROTOCOL_VERSION,
      };
    } finally {
      zeroOutcome(outcome);
    }
    phase = "terminal";
    await cleanupScratch();
    armTerminalExit();
    sendCurrent();
  };

  const publishReconnectSnapshot = (socket) => {
    currentEvent ??= stateEvent(attemptId, "waiting_spawn");
    if (
      phase === "terminal" &&
      childIdentityEvent &&
      currentEvent !== childIdentityEvent
    ) {
      writeEvent(socket, childIdentityEvent);
    }
    writeEvent(socket, currentEvent);
  };

  const sendCurrent = () => {
    if (activeSocket && !activeSocket.destroyed && currentEvent) {
      writeEvent(activeSocket, currentEvent);
    }
  };

  const armOrphanExit = () => {
    clearTimeout(orphanTimer);
    orphanTimer = setTimeout(() => {
      if (phase === "waiting_spawn") closeServer();
    }, WAITING_SPAWN_RECOVERY_HOLD_MS);
  };

  const armLeaseHorizon = (expiresAt, initial) => {
    const expiryMs = Date.parse(expiresAt);
    const deadlineMs = Date.parse(attemptDeadlineAt ?? "");
    const currentMs = Date.parse(leaseExpiresAt ?? "");
    if (
      !Number.isFinite(expiryMs) ||
      !Number.isFinite(deadlineMs) ||
      leaseExpired ||
      expiryMs > deadlineMs ||
      expiryMs <= Date.now() ||
      (
        !initial &&
        Number.isFinite(currentMs) &&
        expiryMs < currentMs
      )
    ) {
      return false;
    }
    if (expiresAt === leaseExpiresAt) return true;
    leaseExpiresAt = expiresAt;
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(
      enforceLeaseHorizon,
      Math.max(0, expiryMs - Date.now()),
    );
    return true;
  };

  const enforceLeaseHorizon = () => {
    if (phase === "terminal") return;
    leaseExpired = true;
    terminationReason ??= "lease_lost";
    if (phase === "waiting_spawn") {
      phase = "terminal";
      currentEvent = faultEvent(attemptId, terminationReason);
      armTerminalExit();
      sendCurrent();
      return;
    }
    controller?.abort();
    inputGate?.resolve();
    inputGate = undefined;
  };

  const armTerminalExit = () => {
    clearTimeout(terminalTimer);
    const deadline = Date.parse(attemptDeadlineAt ?? "");
    const untilDeadline = Number.isFinite(deadline)
      ? deadline + TERMINAL_HOLD_GRACE_MS - Date.now()
      : TERMINAL_HOLD_MAX_MS;
    terminalTimer = setTimeout(
      closeServer,
      Math.max(
        SUPERVISOR_HANDSHAKE_TIMEOUT_MS,
        Math.min(TERMINAL_HOLD_MAX_MS, untilDeadline),
      ),
    );
  };

  const cleanupScratch = async () => {
    if (!currentScratch) return;
    const scratch = currentScratch;
    currentScratch = undefined;
    await rm(scratch, { force: true, recursive: true });
  };

  const closeServer = () => {
    clearTimeout(leaseTimer);
    clearTimeout(orphanTimer);
    clearTimeout(terminalTimer);
    for (const socket of sockets) socket.destroy();
    server.close(() => {
      process.exitCode = 0;
    });
  };

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ exclusive: true, host: ADDRESS, port: 0 }, resolveListen);
  });
  const address = server.address();
  if (
    !address ||
    typeof address !== "object" ||
    address.address !== ADDRESS ||
    address.port < 1_024
  ) {
    throw new Error("invalid");
  }
  process.stdout.write(
    encodeSupervisorBootstrap({
      kind: "ready",
      pid: process.pid,
      port: address.port,
      token,
      v: SUPERVISOR_PROTOCOL_VERSION,
    }),
  );
  armOrphanExit();
}

async function prepareExecution({ attemptId, request }) {
  const root = await realpath(request.cwdRoot);
  const rootMetadata = await lstat(root);
  if (
    root !== request.cwdRoot ||
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== process.geteuid() ||
    (rootMetadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("invalid");
  }
  const executable = await realpath(request.executableRealPath);
  const executableMetadata = await lstat(executable);
  if (
    executable !== request.executableRealPath ||
    !executableMetadata.isFile() ||
    executableMetadata.isSymbolicLink() ||
    ![0, process.geteuid()].includes(executableMetadata.uid) ||
    (executableMetadata.mode & 0o022) !== 0 ||
    (executableMetadata.mode & 0o6000) !== 0 ||
    (executableMetadata.mode & 0o111) === 0
  ) {
    throw new Error("invalid");
  }
  const scratch = join(root, attemptId);
  let created = false;
  let input;
  try {
    await mkdir(scratch, { mode: 0o700 });
    created = true;
    await chmod(scratch, 0o700);
    const cwd = join(scratch, "cwd");
    await mkdir(cwd, { mode: 0o700 });
    await chmod(cwd, 0o700);
    input = Buffer.from(request.inputBase64, "base64url");
    if (
      input.byteLength < 1 ||
      createHash("sha256").update(input).digest("hex") !==
        request.inputSha256
    ) {
      throw new Error("invalid");
    }
    return { input, scratch };
  } catch (error) {
    input?.fill(0);
    if (created) await rm(scratch, { force: true, recursive: true });
    throw error;
  }
}

function executionReceipt(request, outcome, terminationReason) {
  const finishedAt = monotonicNow(outcome.startedAt);
  let cancelRequested = false;
  let exitCode = outcome.exitCode;
  let reason;
  let status = "failed";
  let timedOut = false;
  if (outcome.canceled) {
    reason = terminationReason ?? "interrupted_after_start";
    cancelRequested = reason === "cancel_requested";
    exitCode = null;
    status = cancelRequested ? "canceled" : "failed";
  } else if (outcome.timedOut) {
    exitCode = null;
    reason = "timed_out";
    timedOut = true;
  } else if (outcome.overflowed) {
    exitCode = null;
    reason = "output_limit_reached";
  } else if (outcome.errorCode) {
    exitCode = null;
    reason = "interrupted_after_start";
  } else if (outcome.exitCode === 0) {
    reason = "none";
    status = "succeeded";
  } else if (
    Number.isInteger(outcome.exitCode) &&
    outcome.exitCode >= 1 &&
    outcome.exitCode <= 255
  ) {
    reason = "engine_exit_nonzero";
  } else if (outcome.exitCode === null) {
    reason = "interrupted_after_start";
  } else {
    exitCode = null;
    reason = "protocol_invalid";
  }
  const receipt = {
    cancelRequested,
    engine: request.engine,
    engineVersion: request.engineVersion,
    exitCode,
    finishedAt,
    reason,
    startedAt: outcome.startedAt,
    status,
    stderr: streamReceipt(outcome.stderr, STDERR_EXCERPT_BYTES),
    stdout: streamReceipt(outcome.stdout, STDOUT_EXCERPT_BYTES),
    summary: status === "succeeded" ? "completed" : reason,
    timedOut,
  };
  if (!parseEngineExecutionResult(receipt)) throw new Error("invalid");
  return receipt;
}

function streamReceipt(bytes, excerptMaximum) {
  const value = Buffer.from(bytes);
  const excerpt = value.subarray(0, excerptMaximum);
  const receipt = {
    bytes: value.byteLength,
    excerptBase64Url: excerpt.toString("base64url"),
    sha256: createHash("sha256").update(value).digest("hex"),
    truncated: excerpt.byteLength < value.byteLength,
  };
  value.fill(0);
  return receipt;
}

function executionHome() {
  const home = process.env.HOME;
  if (!home || !home.startsWith(sep)) throw new Error("invalid");
  return home;
}

function createBoundedFrameReader(socket, maximum, onFrame) {
  let buffered = Buffer.alloc(0);
  let closed = false;
  const frames = [];
  let processing = false;

  const fail = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
  };
  const drain = async () => {
    if (processing || closed) return;
    processing = true;
    try {
      while (frames.length > 0 && !closed) {
        const frame = frames.shift();
        if (frames.length < 2) socket.resume();
        await onFrame(frame);
      }
    } catch {
      fail();
    } finally {
      processing = false;
      if (frames.length > 0 && !closed) drain();
    }
  };
  const onData = (chunk) => {
    if (closed || chunk.byteLength > maximum * 3) {
      fail();
      return;
    }
    if (buffered.byteLength + chunk.byteLength > maximum * 3) {
      fail();
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    while (!closed) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.byteLength > maximum) fail();
        break;
      }
      const frame = buffered.subarray(0, newline + 1);
      buffered = buffered.subarray(newline + 1);
      if (frame.byteLength > maximum || frames.length >= 2) {
        fail();
        break;
      }
      frames.push(Buffer.from(frame));
      if (frames.length >= 2) socket.pause();
    }
    drain();
  };
  const onEnd = () => {
    if (buffered.byteLength > 0) fail();
  };
  socket.on("data", onData);
  socket.once("end", onEnd);
  return () => {
    closed = true;
    socket.off("data", onData);
    socket.off("end", onEnd);
    buffered.fill(0);
    buffered = Buffer.alloc(0);
    frames.length = 0;
  };
}

function writeEvent(socket, event) {
  socket.write(encodeSupervisorEvent(event));
}

function zeroOutcome(outcome) {
  outcome?.stdout?.fill(0);
  outcome?.stderr?.fill(0);
}

function requestFingerprint(request) {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
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

function stateEvent(attemptId, state) {
  return {
    attemptId,
    kind: "state",
    state,
    v: SUPERVISOR_PROTOCOL_VERSION,
  };
}

function faultEvent(attemptId, code) {
  return {
    attemptId,
    code,
    kind: "state",
    state: "fault",
    v: SUPERVISOR_PROTOCOL_VERSION,
  };
}

function sameToken(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== right.length
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex"),
  );
}

function monotonicNow(minimum) {
  const now = new Date().toISOString();
  return now < minimum ? minimum : now;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  const argument = resolve(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  try {
    const canonical = realpathSync.native ?? realpathSync;
    return canonical(argument) === canonical(modulePath);
  } catch {
    return argument === modulePath;
  }
}
