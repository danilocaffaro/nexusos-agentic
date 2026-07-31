import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nexusDir = join(projectRoot, ".nexusos");
const logsDir = join(nexusDir, "logs");
const keyPath = join(nexusDir, "remote-tunnel-ed25519");
const configPath = join(nexusDir, "remote.env");
const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
const action = process.argv[2] ?? "status";
const options = parseOptions(process.argv.slice(3));
const uid = process.getuid?.();

if (process.platform !== "darwin") {
  throw new Error("The persistent remote service installer currently supports macOS.");
}
if (action === "prepare") {
  prepareKey();
  process.stdout.write(`${readPublicKey()}\n`);
  process.stdout.write(
    "Install this public key on the Oracle gateway before running install.\n",
  );
} else if (action === "install") {
  installServices();
} else if (action === "status") {
  statusServices();
} else {
  throw new Error(
    "Usage: npm run remote:service -- prepare|install|status [options]",
  );
}

function prepareKey() {
  mkdirSync(nexusDir, { recursive: true, mode: 0o700 });
  chmodSync(nexusDir, 0o700);
  if (existsSync(keyPath)) {
    assertPrivateMode(keyPath);
    return;
  }
  run("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "nexusos-reverse-tunnel",
    "-f",
    keyPath,
  ]);
  chmodSync(keyPath, 0o600);
  chmodSync(`${keyPath}.pub`, 0o644);
}

function installServices() {
  if (!options.sshTarget) {
    throw new Error("install requires --ssh-target USER@HOST");
  }
  if (!existsSync(configPath)) {
    throw new Error("Run npm run remote:init before installing services.");
  }
  assertPrivateMode(configPath);
  prepareKey();
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  mkdirSync(launchAgentsDir, { recursive: true });

  const appLabel = "com.nexusos.remote.app";
  const tunnelLabel = "com.nexusos.remote.tunnel";
  const appPlist = join(launchAgentsDir, `${appLabel}.plist`);
  const tunnelPlist = join(launchAgentsDir, `${tunnelLabel}.plist`);
  writeFileSync(
    appPlist,
    plist(appLabel, [
      process.execPath,
      join(projectRoot, "scripts", "remote-ready.mjs"),
      "--port",
      String(options.localPort),
      "--state-dir",
      options.stateDirectory,
    ], {
      workingDirectory: projectRoot,
      stdout: join(logsDir, "app.log"),
      stderr: join(logsDir, "app.error.log"),
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    tunnelPlist,
    plist(tunnelLabel, [
      "/usr/bin/ssh",
      "-N",
      "-T",
      "-i",
      keyPath,
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=yes",
      "-R",
      `127.0.0.1:${options.remotePort}:127.0.0.1:${options.localPort}`,
      options.sshTarget,
    ], {
      stdout: join(logsDir, "tunnel.log"),
      stderr: join(logsDir, "tunnel.error.log"),
    }),
    { mode: 0o600 },
  );
  run("/usr/bin/plutil", ["-lint", appPlist]);
  run("/usr/bin/plutil", ["-lint", tunnelPlist]);

  for (const [label, path] of [
    [appLabel, appPlist],
    [tunnelLabel, tunnelPlist],
  ]) {
    spawnSync("/bin/launchctl", [
      "bootout",
      `gui/${uid}/${label}`,
    ], { stdio: "ignore" });
    run("/bin/launchctl", ["bootstrap", `gui/${uid}`, path]);
    run("/bin/launchctl", [
      "enable",
      `gui/${uid}/${label}`,
    ]);
    run("/bin/launchctl", [
      "kickstart",
      "-k",
      `gui/${uid}/${label}`,
    ]);
  }
  process.stdout.write(
    [
      "NexusOS persistent remote services installed.",
      `  local app: 127.0.0.1:${options.localPort}`,
      `  state: ${options.stateDirectory}`,
      `  Oracle listener: 127.0.0.1:${options.remotePort}`,
      `  SSH target: ${options.sshTarget}`,
      `  logs: ${logsDir}`,
      "Run: npm run remote:service -- status",
      "",
    ].join("\n"),
  );
}

function statusServices() {
  if (uid === undefined) throw new Error("Unable to resolve the current uid.");
  for (const label of [
    "com.nexusos.remote.app",
    "com.nexusos.remote.tunnel",
  ]) {
    const result = spawnSync(
      "/bin/launchctl",
      ["print", `gui/${uid}/${label}`],
      { encoding: "utf8" },
    );
    const state =
      result.status === 0
        ? result.stdout.match(/state = ([^\n]+)/u)?.[1] ?? "loaded"
        : "not installed";
    process.stdout.write(`${label}: ${state}\n`);
  }
}

function readPublicKey() {
  const value = readFileSync(`${keyPath}.pub`, "utf8").trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/u.test(value)) {
    throw new Error("Generated tunnel public key is invalid.");
  }
  return value;
}

function assertPrivateMode(path) {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} must not be accessible by group or others.`);
  }
}

function plist(label, argumentsList, paths = {}) {
  const argumentsXml = argumentsList
    .map((value) => `      <string>${xml(value)}</string>`)
    .join("\n");
  const workingDirectory = paths.workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${xml(paths.workingDirectory)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>${workingDirectory}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(paths.stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(paths.stderr)}</string>
  </dict>
</plist>
`;
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseOptions(args) {
  const parsed = {
    localPort: 3003,
    remotePort: 3410,
    sshTarget: "",
    stateDirectory: join(projectRoot, ".wrangler", "state"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--ssh-target") {
      parsed.sshTarget = args[++index] ?? "";
    } else if (argument === "--local-port") {
      parsed.localPort = parsePort(args[++index]);
    } else if (argument === "--remote-port") {
      parsed.remotePort = parsePort(args[++index]);
    } else if (argument === "--state-dir") {
      const value = args[++index] ?? "";
      if (!value.startsWith("/")) {
        throw new Error("--state-dir must be an absolute path.");
      }
      parsed.stateDirectory = resolve(value);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (
    parsed.sshTarget &&
    !/^[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.:-]*$/u.test(
      parsed.sshTarget,
    )
  ) {
    throw new Error("--ssh-target must have the form USER@HOST.");
  }
  return parsed;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("Ports must be integers between 1024 and 65535.");
  }
  return port;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? "no status"}.`);
  }
}
