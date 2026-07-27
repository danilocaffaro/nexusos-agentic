import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat as nodeLstat,
  open,
  realpath as nodeRealpath,
} from "node:fs/promises";
import { isAbsolute } from "node:path";
import process from "node:process";

const TERMINATION_GRACE_MS = 2_000;
const FORCE_SETTLE_MS = 1_000;
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

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

export function createEngineProcessAdapter() {
  requireSupportedPlatform();
  return Object.freeze({
    runBounded(input) {
      validateProcessInput(input);
      return runBounded(input);
    },
  });
}

function runBounded(input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(input.executableRealPath, [...input.argv], {
        cwd: input.cwd,
        detached: true,
        env: { ...input.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve(failedSpawn(error));
      return;
    }

    let closeCode = null;
    let closeObserved = false;
    let errorCode;
    let finished = false;
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

    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(grace);
      clearTimeout(forceSettle);
      child.stdout?.destroy();
      child.stderr?.destroy();
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

    const terminate = () => {
      if (terminating || finished) return;
      terminating = true;
      signalGroup("SIGTERM");
      grace = setTimeout(() => {
        signalGroup("SIGKILL");
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

    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.stdout.on("error", () => {
      errorCode ??= "EIO";
      terminate();
    });
    child.stderr.on("error", () => {
      errorCode ??= "EIO";
      terminate();
    });
    child.once("error", (error) => {
      errorCode = typeof error?.code === "string" ? error.code : "EIO";
      if (!child.pid) finish(null);
      else terminate();
    });
    child.once("close", (code) => {
      closeObserved = true;
      closeCode = Number.isInteger(code) ? code : null;
      if (terminating) signalGroup("SIGKILL");
      finish(closeCode);
    });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
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
  return {
    ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
    exitCode: null,
    overflowed: false,
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
    timedOut: false,
  };
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
