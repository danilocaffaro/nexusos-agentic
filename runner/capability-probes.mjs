import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import process from "node:process";

export const CAPABILITY_ORDER = Object.freeze([
  "node_permission_model",
  "bubblewrap",
  "landlock",
  "seccomp",
  "user_namespace",
  "docker",
  "podman",
]);

export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_STREAM_MAX_BYTES = 16 * 1_024;
export const PROC_STATUS_MAX_BYTES = 8 * 1_024;
export const PROC_INTEGER_MAX_BYTES = 64;

const LINUX = Object.freeze(["linux"]);
const LINUX_AND_DARWIN = Object.freeze(["linux", "darwin"]);
const ALL_PLATFORMS = Object.freeze([
  "aix",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32",
]);

export const PROBE_SPECS = deepFreeze([
  {
    capability: "node_permission_model",
    kind: "node_flag",
    platforms: ALL_PLATFORMS,
    executable: "process.execPath",
    argv: ["--permission", "-e", "process.exit(0)"],
  },
  {
    capability: "bubblewrap",
    kind: "binary_version",
    platforms: LINUX,
    candidates: ["/usr/bin/bwrap", "/usr/local/bin/bwrap"],
    argv: ["--version"],
  },
  {
    capability: "landlock",
    kind: "none",
    platforms: [],
    candidates: [],
    argv: [],
  },
  {
    capability: "seccomp",
    kind: "proc_read",
    platforms: LINUX,
    sources: ["/proc/self/status"],
  },
  {
    capability: "user_namespace",
    kind: "proc_read",
    platforms: LINUX,
    sources: [
      "/proc/sys/user/max_user_namespaces",
      "/proc/sys/kernel/unprivileged_userns_clone",
    ],
  },
  {
    capability: "docker",
    kind: "binary_version",
    platforms: LINUX_AND_DARWIN,
    candidates: [
      "/usr/bin/docker",
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
    ],
    argv: ["--version"],
  },
  {
    capability: "podman",
    kind: "binary_version",
    platforms: LINUX_AND_DARWIN,
    candidates: [
      "/usr/bin/podman",
      "/usr/local/bin/podman",
      "/opt/homebrew/bin/podman",
    ],
    argv: ["--version"],
  },
]);

export async function collectCapabilityEvidence(options = {}) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const testRoot = options.testRoot;
  if (
    !ALL_PLATFORMS.includes(platform) ||
    typeof execPath !== "string" ||
    !isAbsolute(execPath) ||
    (testRoot !== undefined &&
      (typeof testRoot !== "string" || !isAbsolute(testRoot)))
  ) {
    throw new TypeError("Capability probe configuration is invalid.");
  }

  return Promise.all(
    PROBE_SPECS.map(async (spec) => {
      try {
        return await collectOne({
          spec,
          platform,
          execPath,
          testRoot,
        });
      } catch {
        return item(
          spec.capability,
          "unknown",
          detectionFor(spec),
          "unknown",
        );
      }
    }),
  );
}

async function collectOne({ spec, platform, execPath, testRoot }) {
  if (spec.capability === "landlock") {
    return item("landlock", "unknown", "none", "probe_disabled");
  }
  if (!spec.platforms.includes(platform)) {
    if (
      (spec.capability === "docker" || spec.capability === "podman") &&
      platform !== "linux" &&
      platform !== "darwin"
    ) {
      return item(
        spec.capability,
        "unknown",
        "none",
        "probe_disabled",
      );
    }
    return item(
      spec.capability,
      "unavailable",
      "none",
      "not_supported",
    );
  }

  if (spec.capability === "node_permission_model") {
    return probeNodePermissionModel(execPath, spec.argv);
  }
  if (spec.capability === "seccomp") {
    return probeSeccomp(rooted(testRoot, spec.sources[0]));
  }
  if (spec.capability === "user_namespace") {
    return probeUserNamespace(
      rooted(testRoot, spec.sources[0]),
      rooted(testRoot, spec.sources[1]),
    );
  }
  return probeBinary(spec, testRoot);
}

async function probeNodePermissionModel(execPath, argv) {
  const outcome = await runBoundedProbe(execPath, argv);
  if (outcome.errorCode === "EACCES") {
    return item(
      "node_permission_model",
      "unknown",
      "node_flag",
      "permission_denied",
    );
  }
  if (outcome.errorCode || outcome.timedOut || outcome.overflowed) {
    return item(
      "node_permission_model",
      "unknown",
      "node_flag",
      "unknown",
    );
  }
  if (outcome.exitCode === 0) {
    return item(
      "node_permission_model",
      "available",
      "node_flag",
      "none",
      execPath === process.execPath ? process.version : undefined,
    );
  }
  if (outcome.exitCode === 9) {
    return item(
      "node_permission_model",
      "unavailable",
      "node_flag",
      "not_supported",
    );
  }
  return item(
    "node_permission_model",
    "unknown",
    "node_flag",
    "unknown",
  );
}

async function probeBinary(spec, testRoot) {
  const candidate = await findCandidate(spec.candidates, testRoot);
  if (candidate.kind !== "found") {
    if (candidate.kind === "unknown") {
      return item(
        spec.capability,
        "unknown",
        "binary_version",
        "unknown",
      );
    }
    return item(
      spec.capability,
      "unavailable",
      "binary_version",
      candidate.kind === "permission_denied"
        ? "permission_denied"
        : "not_found",
    );
  }

  const outcome = await runBoundedProbe(candidate.path, spec.argv);
  if (outcome.errorCode === "ENOENT") {
    return item(
      spec.capability,
      "unavailable",
      "binary_version",
      "not_found",
    );
  }
  if (outcome.errorCode === "EACCES") {
    return item(
      spec.capability,
      "unavailable",
      "binary_version",
      "permission_denied",
    );
  }
  if (
    outcome.errorCode ||
    outcome.exitCode !== 0 ||
    outcome.timedOut ||
    outcome.overflowed
  ) {
    return item(
      spec.capability,
      "unknown",
      "binary_version",
      "unknown",
    );
  }

  const version = parseVersion(spec.capability, outcome.stdout);
  return version
    ? item(
        spec.capability,
        "available",
        "binary_version",
        "none",
        version,
      )
    : item(
        spec.capability,
        "unknown",
        "binary_version",
        "unknown",
      );
}

async function probeSeccomp(path) {
  const result = await readBoundedFile(path, PROC_STATUS_MAX_BYTES);
  if (result.kind === "permission_denied") {
    return item(
      "seccomp",
      "unknown",
      "proc_read",
      "permission_denied",
    );
  }
  if (result.kind !== "ok") {
    return item("seccomp", "unknown", "proc_read", "unknown");
  }
  if (/^Seccomp:[ \t]+[012][ \t]*$/mu.test(result.text)) {
    return item("seccomp", "available", "proc_read", "none");
  }
  if (!result.overflowed && !/^Seccomp:/mu.test(result.text)) {
    return item(
      "seccomp",
      "unavailable",
      "proc_read",
      "not_supported",
    );
  }
  return item("seccomp", "unknown", "proc_read", "unknown");
}

async function probeUserNamespace(maxPath, clonePath) {
  const maximum = await readSmallInteger(maxPath);
  if (maximum.kind === "permission_denied") {
    return item(
      "user_namespace",
      "unknown",
      "proc_read",
      "permission_denied",
    );
  }
  if (maximum.kind !== "value") {
    return item(
      "user_namespace",
      "unknown",
      "proc_read",
      "unknown",
    );
  }
  if (maximum.value === 0) {
    return item(
      "user_namespace",
      "unavailable",
      "proc_read",
      "none",
    );
  }

  const clone = await readSmallInteger(clonePath);
  if (clone.kind === "permission_denied") {
    return item(
      "user_namespace",
      "unknown",
      "proc_read",
      "permission_denied",
    );
  }
  if (clone.kind === "value" && clone.value === 0) {
    return item(
      "user_namespace",
      "unavailable",
      "proc_read",
      "none",
    );
  }
  if (clone.kind === "value" || clone.kind === "missing") {
    return item(
      "user_namespace",
      "available",
      "proc_read",
      "none",
    );
  }
  return item(
    "user_namespace",
    "unknown",
    "proc_read",
    "unknown",
  );
}

async function findCandidate(candidates, testRoot) {
  let permissionDenied = false;
  for (const fixedPath of candidates) {
    const path = rooted(testRoot, fixedPath);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) continue;
      if (!isTrustedExecutable(metadata)) return { kind: "unknown" };
      return { kind: "found", path };
    } catch (error) {
      if (error?.code === "EACCES") {
        permissionDenied = true;
      } else if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        return { kind: "unknown" };
      }
    }
  }
  return {
    kind: permissionDenied ? "permission_denied" : "not_found",
  };
}

async function readSmallInteger(path) {
  const result = await readBoundedFile(path, PROC_INTEGER_MAX_BYTES);
  if (result.kind === "missing") return { kind: "missing" };
  if (result.kind === "permission_denied") {
    return { kind: "permission_denied" };
  }
  if (
    result.kind !== "ok" ||
    result.overflowed ||
    !/^\d{1,10}\n?$/u.test(result.text)
  ) {
    return { kind: "invalid" };
  }
  const value = Number(result.text.trim());
  return Number.isSafeInteger(value)
    ? { kind: "value", value }
    : { kind: "invalid" };
}

async function readBoundedFile(path, maximumBytes) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return {
      kind: "ok",
      text: buffer.subarray(0, Math.min(bytesRead, maximumBytes)).toString(
        "utf8",
      ),
      overflowed: bytesRead > maximumBytes,
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { kind: "missing" };
    }
    if (error?.code === "EACCES") {
      return { kind: "permission_denied" };
    }
    return { kind: "error" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function runBoundedProbe(executable, argv) {
  return new Promise((resolveProbe) => {
    let child;
    try {
      child = spawn(executable, argv, {
        detached: process.platform !== "win32",
        env: {},
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolveProbe({
        errorCode: error?.code,
        exitCode: null,
        overflowed: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
        timedOut: false,
      });
      return;
    }

    let settled = false;
    let errorCode;
    let overflowed = false;
    let timedOut = false;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer;
    let forceTimer;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolveProbe({
        errorCode,
        exitCode,
        overflowed,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
        timedOut,
      });
    };

    const killProbeTree = () => {
      if (settled) return;
      if (child.pid && process.platform !== "win32") {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      } else {
        child.kill("SIGKILL");
      }
      forceTimer ??= setTimeout(() => finish(null), 250);
    };

    const collect = (target, chunk, stream) => {
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = PROBE_STREAM_MAX_BYTES - current;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (stream === "stdout") {
        stdoutBytes += Math.min(chunk.byteLength, Math.max(remaining, 0));
      } else {
        stderrBytes += Math.min(chunk.byteLength, Math.max(remaining, 0));
      }
      if (chunk.byteLength > Math.max(remaining, 0)) {
        overflowed = true;
        killProbeTree();
      }
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.stdout.on("error", () => {
      errorCode ??= "EIO";
      killProbeTree();
    });
    child.stderr.on("error", () => {
      errorCode ??= "EIO";
      killProbeTree();
    });
    child.once("error", (error) => {
      errorCode = error?.code;
    });
    timer = setTimeout(() => {
      timedOut = true;
      killProbeTree();
    }, PROBE_TIMEOUT_MS);
    child.once("close", finish);
  });
}

function isTrustedExecutable(metadata) {
  if ((metadata.mode & 0o022) !== 0) return false;
  const effectiveUserId = process.geteuid?.();
  return (
    effectiveUserId === undefined ||
    metadata.uid === 0 ||
    metadata.uid === effectiveUserId
  );
}

function parseVersion(capability, bytes) {
  if (bytes.byteLength < 1 || bytes.byteLength > 128) return undefined;
  let line = bytes.toString("utf8");
  if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (line.includes("\n") || line.includes("\r")) return undefined;
  const pattern =
    capability === "bubblewrap"
      ? /^bubblewrap (\d+(?:\.\d+){1,3})$/u
      : capability === "docker"
        ? /^Docker version (\d+\.\d+\.\d+), build [0-9a-f]{7,64}$/u
        : /^podman version (\d+\.\d+\.\d+)$/u;
  const version = pattern.exec(line)?.[1];
  return version && version.length <= 32 ? version : undefined;
}

function rooted(testRoot, fixedPath) {
  return testRoot === undefined ? fixedPath : `${testRoot}${fixedPath}`;
}

function item(capability, status, detection, reasonCode, version) {
  return {
    capability,
    detection,
    reasonCode,
    status,
    ...(version === undefined ? {} : { version }),
  };
}

function detectionFor(spec) {
  return spec.kind === "none" ? "none" : spec.kind;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
