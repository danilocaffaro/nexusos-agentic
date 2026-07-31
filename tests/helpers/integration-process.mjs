import { spawn } from "node:child_process";

const usesProcessGroups = process.platform !== "win32";

export function spawnIntegrationProcess(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    detached: usesProcessGroups,
  });
}

export async function stopIntegrationProcess(child, timeoutMs = 5_000) {
  if (!child) return;

  if (isRunning(child)) {
    signalProcessTree(child, "SIGTERM");
    await waitForExit(child, timeoutMs);
  }

  if (isRunning(child)) {
    signalProcessTree(child, "SIGKILL");
    await waitForExit(child, 2_000);
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  child.unref();
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function signalProcessTree(child, signal) {
  try {
    if (usesProcessGroups && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (!isRunning(child)) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
