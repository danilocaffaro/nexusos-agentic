import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 3002;
const STARTUP_TIMEOUT_MS = 120_000;

const options = parseOptions(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const baseUrl = `http://${DEFAULT_HOSTNAME}:${options.port}`;
const statePath = resolvePath(options.stateDir);
const logPath = join(
  projectRoot,
  ".wrangler",
  "logs",
  `usable-local-${options.port}.log`,
);
const registryPath = join(statePath, "miniflare-registry");
const runtimeEnv = {
  ...process.env,
  CI: "1",
  MINIFLARE_REGISTRY_PATH: registryPath,
  NEXUS_PERSIST_STATE_PATH: statePath,
  NEXUS_RUNNER_AUDIENCE: baseUrl,
  WRANGLER_LOG_PATH: logPath,
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

mkdirSync(statePath, { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(registryPath, { recursive: true });

let activeChild;
let forcedShutdownTimer;
let requestedSignal;

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

try {
  process.stdout.write(
    `Preparing NexusOS local state at ${displayPath(statePath)}\n`,
  );
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
  if (requestedSignal) {
    process.exitCode = signalExitCode(requestedSignal);
  } else {
    activeChild = spawn(
      process.execPath,
      [
        vinextCli,
        "dev",
        "--port",
        String(options.port),
        "--hostname",
        DEFAULT_HOSTNAME,
      ],
      {
        cwd: projectRoot,
        detached: process.platform !== "win32",
        env: runtimeEnv,
        stdio: "inherit",
      },
    );
    activeChild.once("error", (error) => {
      process.stderr.write(`NexusOS server failed to start: ${error.message}\n`);
    });

    await waitForReadiness(activeChild);
    process.stdout.write(
      [
        "",
        "NexusOS usable local release is ready.",
        `URL: ${baseUrl}`,
        `State: ${displayPath(statePath)}`,
        `Runner audience: ${baseUrl}`,
        "Press Ctrl+C to stop safely.",
        "",
      ].join("\n"),
    );

    const { code, signal } = await childExit(activeChild);
    clearTimeout(forcedShutdownTimer);
    activeChild = undefined;
    if (requestedSignal) {
      process.exitCode = signalExitCode(requestedSignal);
    } else if (signal) {
      process.stderr.write(`NexusOS server stopped by ${signal}.\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  }
} catch (error) {
  clearTimeout(forcedShutdownTimer);
  if (activeChild?.exitCode === null) {
    terminateChild(activeChild, "SIGTERM");
  }
  if (!requestedSignal) {
    process.stderr.write(
      `NexusOS usable local release did not become ready: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

function parseOptions(args) {
  const parsed = {
    help: false,
    port: DEFAULT_PORT,
    stateDir: join(".wrangler", "state"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--port") {
      parsed.port = parsePort(requireValue(args, ++index, argument));
    } else if (argument === "--state-dir") {
      parsed.stateDir = requireValue(args, ++index, argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("--port must be an integer between 1024 and 65535");
  }
  return port;
}

function resolvePath(value) {
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
}

function displayPath(value) {
  const relative = value.startsWith(`${projectRoot}/`)
    ? value.slice(projectRoot.length + 1)
    : value;
  return relative || ".";
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: npm run local:ready -- [--state-dir PATH] [--port PORT]",
      "",
      "Starts NexusOS on http://127.0.0.1:3002 by default.",
      "The default D1 state remains project-local at .wrangler/state.",
      "",
      "Options:",
      "  --state-dir PATH  Use an explicit local state directory.",
      "  --port PORT       Override port for isolated testing.",
      "  -h, --help        Show this help.",
      "",
    ].join("\n"),
  );
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
      `migration command exited with ${
        result.signal ?? result.code ?? "unknown status"
      }`,
    );
  }
}

async function waitForReadiness(server) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastFailure = "server has not accepted a connection";
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `server exited early with ${
          server.signalCode ?? `code ${server.exitCode}`
        }`,
      );
    }
    try {
      const [healthResponse, workspaceResponse, runnersResponse] =
        await Promise.all([
          fetch(`${baseUrl}/api/system/health`, { cache: "no-store" }),
          fetch(`${baseUrl}/api/workspace`, { cache: "no-store" }),
          fetch(`${baseUrl}/api/runners`, { cache: "no-store" }),
        ]);
      if (
        !healthResponse.ok ||
        !workspaceResponse.ok ||
        !runnersResponse.ok
      ) {
        lastFailure =
          `health=${healthResponse.status}, ` +
          `workspace=${workspaceResponse.status}, ` +
          `runners=${runnersResponse.status}`;
      } else {
        const [health, workspace, runners] = await Promise.all([
          healthResponse.json(),
          workspaceResponse.json(),
          runnersResponse.json(),
        ]);
        if (health.status !== "ok" || health.database !== "ready") {
          lastFailure = "health did not report an available database";
        } else if (
          !Array.isArray(workspace.projects) ||
          !Array.isArray(workspace.teams) ||
          !Array.isArray(workspace.agents)
        ) {
          lastFailure = "workspace response did not satisfy its read model";
        } else if (runners.audience !== baseUrl) {
          lastFailure =
            `runner audience mismatch: expected ${baseUrl}, ` +
            `received ${String(runners.audience)}`;
        } else {
          return;
        }
      }
    } catch (error) {
      lastFailure =
        error instanceof Error ? error.message : "readiness request failed";
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`readiness timed out (${lastFailure})`);
}

function requestShutdown(signal) {
  if (requestedSignal) {
    if (activeChild?.exitCode === null) terminateChild(activeChild, "SIGKILL");
    return;
  }
  requestedSignal = signal;
  process.stdout.write("\nStopping NexusOS safely...\n");
  if (activeChild?.exitCode === null) {
    terminateChild(activeChild, signal);
    forcedShutdownTimer = setTimeout(() => {
      if (activeChild?.exitCode === null) {
        terminateChild(activeChild, "SIGKILL");
      }
    }, 8_000);
    forcedShutdownTimer.unref();
  }
}

function terminateChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already be gone; fall back to the direct child.
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

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}
