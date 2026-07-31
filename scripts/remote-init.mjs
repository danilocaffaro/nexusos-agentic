import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(projectRoot, ".nexusos", "remote.env");
const options = parseOptions(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}
if (existsSync(configPath) && !options.rotateBootstrap) {
  throw new Error(
    "Remote access is already initialized. Use --rotate-bootstrap only before activation or as part of an explicit recovery procedure.",
  );
}

const publicOrigin = normalizeHttpsOrigin(options.origin);
const bootstrapToken = randomBytes(32).toString("base64url");
const bootstrapTokenHash = createHash("sha256")
  .update(bootstrapToken, "utf8")
  .digest("base64url");
const messageIntegrityKey = randomBytes(48).toString("base64url");

mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
writeFileSync(
  configPath,
  [
    "NEXUS_REMOTE_ACCESS=1",
    `NEXUS_PUBLIC_ORIGIN=${publicOrigin}`,
    `NEXUS_REMOTE_BOOTSTRAP_TOKEN_SHA256=${bootstrapTokenHash}`,
    "NEXUS_REMOTE_SESSION_TTL_SECONDS=43200",
    `NEXUS_MESSAGE_INTEGRITY_KEY=${messageIntegrityKey}`,
    "",
  ].join("\n"),
  { encoding: "utf8", mode: 0o600 },
);
chmodSync(configPath, 0o600);

process.stdout.write(
  [
    "",
    "NexusOS remote access initialized.",
    `Public URL: ${publicOrigin}`,
    "Configuration: .nexusos/remote.env (mode 0600; ignored by Git)",
    "",
    "ONE-TIME ACTIVATION TOKEN",
    bootstrapToken,
    "",
    "Save this token in your password manager now. It is not stored in plaintext.",
    "Next: npm run remote:ready",
    "",
  ].join("\n"),
);

function parseOptions(args) {
  const parsed = {
    help: false,
    origin: "",
    rotateBootstrap: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--origin") {
      parsed.origin = args[++index] ?? "";
    } else if (argument === "--rotate-bootstrap") {
      parsed.rotateBootstrap = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function normalizeHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--origin must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "--origin must contain only an HTTPS origin, for example https://nexusos.example.com",
    );
  }
  return url.origin;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: npm run remote:init -- --origin https://nexusos.example.com",
      "",
      "Generates the ignored, mode-0600 remote security configuration and",
      "prints a one-time activation token. The plaintext token is never saved.",
      "",
      "Options:",
      "  --origin URL         Required public HTTPS origin.",
      "  --rotate-bootstrap   Replace a pre-activation token deliberately.",
      "  -h, --help           Show this help.",
      "",
    ].join("\n"),
  );
}
