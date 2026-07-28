import { dirname, isAbsolute } from "node:path";
import { ENGINE_METADATA_SPECS } from "./engine-probes.mjs";

const CLAUDE_SETTINGS = JSON.stringify({
  permissions: {
    allow: [],
    ask: [],
    deny: [],
  },
});
const EMPTY_MCP = JSON.stringify({ mcpServers: {} });
const CODEX_DISABLED_FEATURES = Object.freeze([
  "apps",
  "goals",
  "hooks",
  "multi_agent",
  "remote_plugin",
  "shell_snapshot",
  "shell_tool",
]);
const ANALYSIS_SYSTEM_PROMPT =
  "Return a text analysis of the supplied request. Do not use tools, read workspace files, execute commands, modify state, or contact third-party systems.";

export class EngineLaunchRecipeError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineLaunchRecipeError";
    this.code = "engine_launch_recipe_invalid";
  }
}

export function createEngineLaunchRecipe(input) {
  if (
    !plainRecord(input) ||
    !hasExactKeys(input, [
      "engine",
      "engineVersion",
      "executableRealPath",
      "home",
      "scratch",
    ]) ||
    !isAbsolute(input.executableRealPath ?? "") ||
    !isAbsolute(input.home ?? "") ||
    !isAbsolute(input.scratch ?? "")
  ) {
    throw invalidRecipe();
  }
  const spec = ENGINE_METADATA_SPECS[input.engine];
  if (!spec?.supportedVersions.includes(input.engineVersion)) {
    throw invalidRecipe();
  }
  const argv = input.engine === "claude_code_cli"
    ? claudeArgv()
    : input.engine === "codex_cli"
      ? codexArgv(input.scratch)
      : undefined;
  if (!argv) throw invalidRecipe();
  return deepFreeze({
    argv,
    cwd: input.scratch,
    env: {
      HOME: input.home,
      LANG: "C",
      LC_ALL: "C",
      PATH: `${dirname(input.executableRealPath)}:/usr/bin:/bin`,
      TERM: "dumb",
      TMPDIR: input.scratch,
      ...(input.engine === "claude_code_cli"
        ? { CLAUDE_CODE_SAFE_MODE: "1" }
        : {}),
    },
    profile: "analysis_only_v1",
  });
}

function claudeArgv() {
  return [
    "--print",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP,
    "--settings",
    CLAUDE_SETTINGS,
    "--system-prompt",
    ANALYSIS_SYSTEM_PROMPT,
    "--output-format",
    "text",
    "--prompt-suggestions",
    "false",
  ];
}

function codexArgv(scratch) {
  return [
    "exec",
    "--strict-config",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--json",
    "--cd",
    scratch,
    "--config",
    'approval_policy="never"',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => [
      "--disable",
      feature,
    ]),
    "-",
  ];
}

function invalidRecipe() {
  return new EngineLaunchRecipeError(
    "Engine launch recipe is invalid.",
  );
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => actual.includes(key))
  );
}

function plainRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
