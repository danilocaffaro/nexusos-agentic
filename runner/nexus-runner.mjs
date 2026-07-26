#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const CLI_VERSION = "0.1.0";
const STATE_VERSION = 1;
const DEFAULT_INTERVAL_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const PRINCIPAL_ID_PATTERN = /^prn_[0-9a-f]{32}$/u;

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

try {
  const command = process.argv[2] ?? "help";
  const args = parseArgs(process.argv.slice(3));
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "version" || command === "--version") {
    process.stdout.write(`${CLI_VERSION}\n`);
  } else if (command === "enroll") {
    await enroll(args);
  } else if (command === "heartbeat") {
    await heartbeatOnce(args);
  } else if (command === "run") {
    await heartbeatLoop(args);
  } else {
    throw new CliError("Unknown command.", 64);
  }
} catch (error) {
  const normalized =
    error instanceof CliError
      ? error
      : new CliError("The runner command failed unexpectedly.", 1);
  process.stderr.write(`nexus-runner: ${normalized.message}\n`);
  process.exitCode = normalized.exitCode;
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

async function sendHeartbeat({ stateDir, serverOverride }) {
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
  authorization,
}) {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(16).toString("base64url");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const stringToSign = [
    domain,
    "POST",
    pathname,
    audience,
    timestamp,
    nonce,
    `sha256:${bodyHash}`,
  ].join("\n");
  const signature = sign(null, Buffer.from(stringToSign, "utf8"), privateKey);
  return fetch(`${audience}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.byteLength),
      "x-nexus-runner-key": publicKey,
      "x-nexus-signature": signature.toString("base64url"),
      "x-nexus-timestamp": timestamp,
      "x-nexus-nonce": nonce,
      ...(authorization ? { authorization } : {}),
    },
    body,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
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
  const limit = 64 * 1_024;
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) {
    throw new CliError("NexusOS response exceeds the runner limit.", 76);
  }
  if (!response.body) return "";
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
  return Buffer.concat(chunks, size).toString("utf8");
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
    if (name === "token-stdin") {
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
  nexus-runner run [--server <origin>] [--interval-seconds <10..300>] [--state-dir <path>]

Enrollment secrets are accepted only through a hidden TTY prompt or standard
input with --token-stdin. They are never accepted as arguments or environment
variables. Identity and heartbeat are implemented; execution and sandboxing are
not part of this runner version.
`);
}
