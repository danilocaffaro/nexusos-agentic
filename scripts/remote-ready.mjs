import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(projectRoot, ".nexusos", "remote.env");
const configuration = readConfiguration(configPath);
const options = readOptions(process.argv.slice(2));
const port = options.port;
const statePath =
  options.stateDirectory ?? join(projectRoot, ".wrangler", "state");
const registryPath = join(statePath, "miniflare-registry");
const baseUrl = `http://127.0.0.1:${port}`;
const publicOrigin = configuration.NEXUS_PUBLIC_ORIGIN;
const runtimeEnv = {
  ...process.env,
  ...configuration,
  CI: "1",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  MINIFLARE_REGISTRY_PATH: registryPath,
  NEXUS_PERSIST_STATE_PATH: statePath,
  NEXUS_RUNNER_AUDIENCE: baseUrl,
  WRANGLER_WRITE_LOGS: "false",
};
const wranglerCli = join(
  projectRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const vinextCli = join(
  projectRoot,
  "node_modules",
  "vinext",
  "dist",
  "cli.js",
);
const viteCli = join(
  projectRoot,
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);

if (configuration.NEXUS_REMOTE_ACCESS !== "1") {
  throw new Error("remote.env does not enable NEXUS_REMOTE_ACCESS");
}
if (!publicOrigin?.startsWith("https://")) {
  throw new Error("remote.env does not contain a valid HTTPS public origin");
}

mkdirSync(statePath, { recursive: true });
mkdirSync(registryPath, { recursive: true });

let activeChild;
let requestedSignal;
let shutdownTimer;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => requestShutdown(signal));
}

try {
  process.stdout.write("Applying local NexusOS migrations…\n");
  await runChild(process.execPath, [
    wranglerCli,
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    join(projectRoot, "wrangler.local.jsonc"),
    "--persist-to",
    statePath,
  ]);
  process.stdout.write("Building the production Worker bundle…\n");
  await runChild(process.execPath, [vinextCli, "build"]);
  if (requestedSignal) {
    process.exitCode = requestedSignal === "SIGINT" ? 130 : 143;
  } else {
    activeChild = spawn(
      process.execPath,
      [
        viteCli,
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: projectRoot,
        detached: process.platform !== "win32",
        env: runtimeEnv,
        stdio: "inherit",
      },
    );
    await waitForRemoteReadiness(activeChild);
    process.stdout.write(
      [
        "",
        "NexusOS secure remote runtime is ready.",
        `Public boundary: ${publicOrigin}`,
        `Tunnel target: ${baseUrl}`,
        "Runtime: production build in workerd preview; inspector disabled.",
        "Press Ctrl+C to stop safely.",
        "",
      ].join("\n"),
    );
    const { code, signal } = await childExit(activeChild);
    activeChild = undefined;
    process.exitCode = requestedSignal
      ? requestedSignal === "SIGINT"
        ? 130
        : 143
      : signal
        ? 1
        : (code ?? 1);
  }
} catch (error) {
  if (activeChild?.exitCode === null) {
    terminateChild(activeChild, "SIGTERM");
  }
  process.stderr.write(
    `NexusOS secure remote runtime failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
}

async function waitForRemoteReadiness(server) {
  const deadline = Date.now() + 120_000;
  let lastFailure = "server has not accepted a connection";
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `preview exited early with ${
          server.signalCode ?? `code ${server.exitCode}`
        }`,
      );
    }
    try {
      const [healthResponse, authResponse, workspaceResponse] =
        await Promise.all([
          fetch(`${baseUrl}/api/system/health`, { cache: "no-store" }),
          fetch(`${baseUrl}/api/auth/status`, { cache: "no-store" }),
          fetch(`${baseUrl}/api/workspace`, { cache: "no-store" }),
        ]);
      if (
        healthResponse.ok &&
        authResponse.ok &&
        workspaceResponse.status === 401
      ) {
        const [health, auth] = await Promise.all([
          healthResponse.json(),
          authResponse.json(),
        ]);
        if (
          health.status === "ok" &&
          health.database === "ready" &&
          auth.mode === "remote" &&
          typeof auth.activationRequired === "boolean" &&
          auth.authenticated === false
        ) {
          return;
        }
      }
      lastFailure =
        `health=${healthResponse.status}, auth=${authResponse.status}, ` +
        `anonymous_workspace=${workspaceResponse.status}`;
    } catch (error) {
      lastFailure =
        error instanceof Error ? error.message : "readiness request failed";
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`remote readiness timed out (${lastFailure})`);
}

async function runChild(command, args) {
  activeChild = spawn(command, args, {
    cwd: projectRoot,
    detached: process.platform !== "win32",
    env: runtimeEnv,
    stdio: "inherit",
  });
  const result = await childExit(activeChild);
  activeChild = undefined;
  if (result.code !== 0) {
    throw new Error(
      `command failed with ${result.signal ?? result.code ?? "unknown status"}`,
    );
  }
}

function requestShutdown(signal) {
  if (requestedSignal) {
    if (activeChild?.exitCode === null) terminateChild(activeChild, "SIGKILL");
    return;
  }
  requestedSignal = signal;
  process.stdout.write("\nStopping NexusOS remote runtime safely…\n");
  if (activeChild?.exitCode === null) {
    terminateChild(activeChild, signal);
    shutdownTimer = setTimeout(() => {
      if (activeChild?.exitCode === null) terminateChild(activeChild, "SIGKILL");
    }, 8_000);
    shutdownTimer.unref();
  }
}

function terminateChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through if the process group has already ended.
    }
  }
  child.kill(signal);
}

function childExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function readConfiguration(path) {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(".nexusos/remote.env must not be accessible by group or others");
  }
  const entries = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("remote.env contains an invalid line");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^NEXUS_[A-Z0-9_]+$/u.test(key) || !value) {
      throw new Error("remote.env contains an invalid setting");
    }
    entries[key] = value;
  }
  return entries;
}

function readOptions(args) {
  const options = { port: 3003, stateDirectory: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
        throw new Error("--port must be between 1024 and 65535");
      }
      options.port = value;
    } else if (argument === "--state-dir") {
      const value = args[++index] ?? "";
      if (!isAbsolute(value)) {
        throw new Error("--state-dir must be an absolute path");
      }
      options.stateDirectory = resolve(value);
    } else {
      throw new Error(
        "Usage: npm run remote:ready -- [--port PORT] [--state-dir ABSOLUTE_PATH]",
      );
    }
  }
  return options;
}
