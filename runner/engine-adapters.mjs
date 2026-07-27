import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat as nodeLstat,
  open,
  realpath as nodeRealpath,
} from "node:fs/promises";
import {
  createConnection,
  createServer,
} from "node:net";
import { isAbsolute } from "node:path";
import process from "node:process";

const TERMINATION_GRACE_MS = 2_000;
const FORCE_SETTLE_MS = 1_000;
const LOOPBACK_SETUP_TIMEOUT_MS = 1_000;
const LOOPBACK_ADDRESS = "127.0.0.1";
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SAFE_ERROR_CODES = new Set([
  "EACCES",
  "EIO",
  "ENOENT",
  "ENOTDIR",
]);

export function createEngineFilesystemAdapter() {
  requireSupportedPlatform();
  return Object.freeze({
    async realpath(path) {
      return nodeRealpath(path);
    },
    async lstat(path) {
      return fileFacts(await nodeLstat(path, { bigint: true }));
    },
    async openNoFollow(path) {
      const flags =
        constants.O_RDONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW;
      const handle = await open(path, flags);
      try {
        const facts = fileFacts(await handle.stat({ bigint: true }));
        return {
          facts,
          close: () => handle.close(),
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    },
  });
}

export function createEngineProcessAdapter(options = {}) {
  requireSupportedPlatform();
  if (
    !plainRecord(options) ||
    !Object.keys(options).every((key) => key === "pairFactory") ||
    (options.pairFactory !== undefined &&
      typeof options.pairFactory !== "function")
  ) {
    throw new TypeError("Engine process adapter options are invalid.");
  }
  const pairFactory =
    options.pairFactory ?? createEngineLoopbackStreamPair;
  return Object.freeze({
    runBounded(input) {
      validateProcessInput(input);
      return runBounded(input, pairFactory);
    },
  });
}

export async function setupEngineLoopbackTransport(
  pairFactory = createEngineLoopbackStreamPair,
) {
  if (typeof pairFactory !== "function") {
    throw new TypeError("Engine loopback pair factory is invalid.");
  }
  const deadlineAt = Date.now() + LOOPBACK_SETUP_TIMEOUT_MS;
  const pairs = [];
  try {
    const stdout = await createPairBeforeDeadline(pairFactory, deadlineAt);
    pairs.push(stdout);
    validateLoopbackPairShape(stdout);
    const stderr = await createPairBeforeDeadline(pairFactory, deadlineAt);
    pairs.push(stderr);
    validateLoopbackPairShape(stderr);
    const setupError = stdout.error?.() ?? stderr.error?.();
    if (setupError) throw setupError;
    return engineLoopbackTransport(stdout, stderr);
  } catch (error) {
    for (const pair of pairs) destroyLoopbackPair(pair);
    throw error;
  }
}

async function createPairBeforeDeadline(pairFactory, deadlineAt) {
  const pending = Promise.resolve().then(() => pairFactory({ deadlineAt }));
  try {
    return await beforeDeadline(pending, deadlineAt);
  } catch (error) {
    pending.then(
      (pair) => destroyLoopbackPair(pair),
      () => undefined,
    );
    throw error;
  }
}

export function validEngineLoopbackIdentity(reader, writer) {
  return Boolean(
    reader &&
      writer &&
      reader.remoteAddress === LOOPBACK_ADDRESS &&
      reader.localAddress === LOOPBACK_ADDRESS &&
      writer.remoteAddress === LOOPBACK_ADDRESS &&
      writer.localAddress === LOOPBACK_ADDRESS &&
      Number.isSafeInteger(reader.remotePort) &&
      Number.isSafeInteger(reader.localPort) &&
      Number.isSafeInteger(writer.remotePort) &&
      Number.isSafeInteger(writer.localPort) &&
      reader.remotePort === writer.localPort &&
      reader.localPort === writer.remotePort,
  );
}

async function runBounded(input, pairFactory) {
  let transport;
  try {
    transport = await setupEngineLoopbackTransport(pairFactory);
  } catch (error) {
    return failedSpawn(error);
  }
  return runWithLoopbackTransport(input, transport);
}

function runWithLoopbackTransport(input, transport) {
  return new Promise((resolve) => {
    const setupError = transport.setupError();
    if (setupError) {
      transport.destroyAll();
      resolve(failedSpawn(setupError));
      return;
    }
    let child;
    try {
      child = spawn(input.executableRealPath, [...input.argv], {
        cwd: input.cwd,
        detached: true,
        env: { ...input.env },
        shell: false,
        stdio: [
          "ignore",
          transport.stdout.writer,
          transport.stderr.writer,
        ],
        windowsHide: true,
      });
    } catch (error) {
      transport.destroyAll();
      resolve(failedSpawn(error));
      return;
    }

    let closeCode = null;
    let closeObserved = false;
    let errorCode;
    let finished = false;
    let groupSwept = false;
    let overflowed = false;
    let terminating = false;
    let timedOut = false;
    let timeout;
    let grace;
    let forceSettle;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const readerDone = {
      stderr: false,
      stdout: false,
    };

    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(grace);
      clearTimeout(forceSettle);
      transport.destroyAll();
      resolve({
        ...(typeof errorCode === "string" ? { errorCode } : {}),
        exitCode,
        overflowed,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
        timedOut,
      });
    };

    const signalGroup = (signal) => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        try {
          return child.kill(signal);
        } catch {
          return false;
        }
      }
    };

    const maybeFinish = () => {
      if (
        !closeObserved ||
        !readerDone.stdout ||
        !readerDone.stderr ||
        (terminating && !groupSwept)
      ) {
        return;
      }
      finish(closeCode);
    };

    const terminate = () => {
      if (terminating || finished) return;
      terminating = true;
      signalGroup("SIGTERM");
      transport.destroyAll();
      if (closeObserved) {
        signalGroup("SIGKILL");
        groupSwept = true;
        finish(closeCode);
        return;
      }
      grace = setTimeout(() => {
        signalGroup("SIGKILL");
        groupSwept = true;
        if (closeObserved) {
          finish(closeCode);
          return;
        }
        forceSettle = setTimeout(() => finish(null), FORCE_SETTLE_MS);
      }, TERMINATION_GRACE_MS);
    };

    const collect = (target, chunk, stream) => {
      const maximum =
        stream === "stdout"
          ? input.maxStdoutBytes
          : input.maxStderrBytes;
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, maximum - current);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      const retained = Math.min(chunk.byteLength, remaining);
      if (stream === "stdout") stdoutBytes += retained;
      else stderrBytes += retained;
      if (chunk.byteLength > remaining) {
        overflowed = true;
        terminate();
      }
    };

    const observeReader = (stream, target) => {
      const reader = transport[stream].reader;
      reader.on("data", (chunk) => collect(target, chunk, stream));
      reader.once("end", () => {
        readerDone[stream] = true;
        maybeFinish();
      });
      reader.once("close", () => {
        readerDone[stream] = true;
        maybeFinish();
      });
      reader.once("error", (error) => {
        errorCode ??= safeErrorCode(error);
        readerDone[stream] = true;
        terminate();
      });
    };

    observeReader("stdout", stdout);
    observeReader("stderr", stderr);
    transport.stdout.writer.once("error", (error) => {
      errorCode ??= safeErrorCode(error);
      terminate();
    });
    transport.stderr.writer.once("error", (error) => {
      errorCode ??= safeErrorCode(error);
      terminate();
    });
    child.once("error", (error) => {
      errorCode = safeErrorCode(error);
      if (!child.pid) finish(null);
      else terminate();
    });
    child.once("close", (code) => {
      closeObserved = true;
      closeCode = Number.isInteger(code) ? code : null;
      if (terminating) {
        signalGroup("SIGKILL");
        groupSwept = true;
        transport.destroyAll();
      } else {
        transport.closeWriters();
      }
      maybeFinish();
    });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
  });
}

export async function createEngineLoopbackStreamPair({
  beforeConnect,
  deadlineAt = Date.now() + LOOPBACK_SETUP_TIMEOUT_MS,
} = {}) {
  if (
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt <= Date.now() ||
    (beforeConnect !== undefined &&
      typeof beforeConnect !== "function")
  ) {
    throw new TypeError("Engine loopback setup input is invalid.");
  }
  const resources = new Set();
  let acceptedCount = 0;
  let reader;
  let rejectAccepted;
  let socketError;
  const recordSocketError = (error) => {
    socketError ??= error;
  };
  try {
    const server = createServer({ allowHalfOpen: true });
    resources.add(server);
    const accepted = new Promise((resolve, reject) => {
      rejectAccepted = reject;
      server.on("connection", (socket) => {
        resources.add(socket);
        socket.on("error", recordSocketError);
        acceptedCount += 1;
        if (acceptedCount !== 1) {
          socket.destroy();
          reject(new Error("Engine loopback identity is invalid."));
          return;
        }
        reader = socket;
        server.close();
        resolve(socket);
      });
      server.once("error", reject);
    });
    accepted.catch(() => undefined);
    await beforeDeadline(
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          {
            exclusive: true,
            host: LOOPBACK_ADDRESS,
            port: 0,
          },
          resolve,
        );
      }),
      deadlineAt,
    );
    const address = server.address();
    if (
      !address ||
      typeof address !== "object" ||
      address.address !== LOOPBACK_ADDRESS ||
      !Number.isSafeInteger(address.port)
    ) {
      throw new Error("Engine loopback listener is invalid.");
    }
    if (beforeConnect) {
      await beforeDeadline(
        Promise.resolve().then(() => beforeConnect(address.port)),
        deadlineAt,
      );
    }
    const writer = createConnection({
      allowHalfOpen: true,
      host: LOOPBACK_ADDRESS,
      port: address.port,
    });
    resources.add(writer);
    writer.on("error", recordSocketError);
    const connected = new Promise((resolve, reject) => {
      writer.once("connect", resolve);
      writer.once("error", reject);
    });
    [reader] = await beforeDeadline(
      Promise.all([accepted, connected]),
      deadlineAt,
    );
    await beforeDeadline(
      new Promise((resolve) => setImmediate(resolve)),
      deadlineAt,
    );
    if (
      acceptedCount !== 1 ||
      server.listening ||
      socketError ||
      !validEngineLoopbackIdentity(reader, writer)
    ) {
      throw new Error("Engine loopback identity is invalid.");
    }
    reader.setNoDelay(true);
    writer.setNoDelay(true);
    return {
      error: () => socketError,
      reader,
      writer,
    };
  } catch (error) {
    rejectAccepted?.(error);
    for (const resource of resources) destroyLoopbackResource(resource);
    throw error;
  }
}

function engineLoopbackTransport(stdout, stderr) {
  let destroyed = false;
  return Object.freeze({
    stderr,
    stdout,
    setupError() {
      return stdout.error?.() ?? stderr.error?.();
    },
    closeWriters() {
      stdout.writer.destroy();
      stderr.writer.destroy();
    },
    destroyAll() {
      if (destroyed) return;
      destroyed = true;
      destroyLoopbackPair(stdout);
      destroyLoopbackPair(stderr);
    },
  });
}

function validateLoopbackPairShape(pair) {
  if (
    !pair ||
    typeof pair !== "object" ||
    typeof pair.reader?.destroy !== "function" ||
    typeof pair.writer?.destroy !== "function"
  ) {
    throw new TypeError("Engine loopback pair is invalid.");
  }
}

function destroyLoopbackPair(pair) {
  destroyLoopbackResource(pair?.reader);
  destroyLoopbackResource(pair?.writer);
}

function destroyLoopbackResource(resource) {
  try {
    if (typeof resource?.destroy === "function") resource.destroy();
    else if (typeof resource?.close === "function") resource.close();
  } catch {
    // Best-effort cleanup; the probe still fails closed.
  }
}

function beforeDeadline(promise, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error("Engine loopback setup timed out."));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Engine loopback setup timed out.")),
      remaining,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function fileFacts(metadata) {
  return {
    dev: metadata.dev.toString(),
    gid: Number(metadata.gid),
    ino: metadata.ino.toString(),
    kind: metadata.isDirectory()
      ? "directory"
      : metadata.isFile()
        ? "file"
        : metadata.isSymbolicLink()
          ? "symlink"
          : "other",
    mode: Number(metadata.mode),
    mtimeMs: Number(metadata.mtimeNs) / 1_000_000,
    size: Number(metadata.size),
    uid: Number(metadata.uid),
  };
}

function validateProcessInput(input) {
  if (
    !plainRecord(input) ||
    !isAbsolute(input.executableRealPath ?? "") ||
    !isAbsolute(input.cwd ?? "") ||
    !Array.isArray(input.argv) ||
    input.argv.length < 1 ||
    input.argv.length > 16 ||
    !input.argv.every(
      (value) =>
        typeof value === "string" &&
        Buffer.byteLength(value, "utf8") <= 256 &&
        !/[\0\r\n]/u.test(value),
    ) ||
    !plainRecord(input.env) ||
    !Object.entries(input.env).every(
      ([key, value]) =>
        /^[A-Z][A-Z0-9_]{0,31}$/u.test(key) &&
        typeof value === "string" &&
        Buffer.byteLength(value, "utf8") <= 2_048 &&
        !value.includes("\0"),
    ) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs !== 5_000 ||
    !Number.isSafeInteger(input.maxStdoutBytes) ||
    input.maxStdoutBytes !== 16 * 1_024 ||
    !Number.isSafeInteger(input.maxStderrBytes) ||
    input.maxStderrBytes !== 16 * 1_024
  ) {
    throw new TypeError("Engine process input is invalid.");
  }
}

function failedSpawn(error) {
  const errorCode = safeErrorCode(error);
  return {
    ...(errorCode ? { errorCode } : {}),
    exitCode: null,
    overflowed: false,
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
    timedOut: false,
  };
}

function safeErrorCode(error) {
  return SAFE_ERROR_CODES.has(error?.code) ? error.code : "EIO";
}

function requireSupportedPlatform() {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new TypeError("Engine adapters require macOS or Linux.");
  }
}

function plainRecord(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}
