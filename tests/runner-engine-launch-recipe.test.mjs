import assert from "node:assert/strict";
import test from "node:test";
import {
  createEngineLaunchRecipe,
  EngineLaunchRecipeError,
} from "../runner/engine-launch-recipe.mjs";
import {
  ENGINE_METADATA_SPECS,
} from "../runner/engine-probes.mjs";

const executableRealPath = "/private/nexus/bin/engine";
const home = "/private/nexus/operator";
const scratch = "/private/nexus/state/engine-scratch-v1/attempt/cwd";

test("Claude launch is analysis-only and ignores global customizations", () => {
  for (
    const engineVersion of
      ENGINE_METADATA_SPECS.claude_code_cli.supportedVersions
  ) {
    const recipe = createEngineLaunchRecipe({
      engine: "claude_code_cli",
      engineVersion,
      executableRealPath,
      home,
      scratch,
    });
    assert.equal(recipe.profile, "analysis_only_v1");
    assert.equal(recipe.cwd, scratch);
    assert.equal(Object.isFrozen(recipe), true);
    assert.equal(Object.isFrozen(recipe.argv), true);
    assert.deepEqual(recipe.env, {
      CLAUDE_CODE_SAFE_MODE: "1",
      HOME: home,
      LANG: "C",
      LC_ALL: "C",
      LOGNAME: "operator",
      NO_COLOR: "1",
      PATH: "/private/nexus/bin:/usr/bin:/bin",
      TERM: "dumb",
      TMPDIR: scratch,
      USER: "operator",
    });
    assert.deepEqual(recipe.argv, [
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
      '{"mcpServers":{}}',
      "--settings",
      '{"permissions":{"allow":[],"ask":[],"deny":[]}}',
      "--system-prompt",
      "Return a text analysis of the request. Do not use tools, read workspace files, execute commands, modify state, or contact third-party systems. For a NexusOS acceptance canary, use no tools and return only its requested sentinel.",
      "--output-format",
      "text",
      "--prompt-suggestions",
      "false",
    ]);
    assertExecutionAdapterBounds(recipe.argv);
    assert.doesNotMatch(JSON.stringify(recipe), /acceptEdits|bypass/u);
  }
});

test("Codex launch is ephemeral, read-only and disables agentic tools", () => {
  for (
    const engineVersion of
      ENGINE_METADATA_SPECS.codex_cli.supportedVersions
  ) {
    const recipe = createEngineLaunchRecipe({
      engine: "codex_cli",
      engineVersion,
      executableRealPath,
      home,
      scratch,
    });
    assert.deepEqual(recipe.argv, [
      "exec",
      "--strict-config",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--json",
      "--config",
      'approval_policy="never"',
      "--config",
      'web_search="disabled"',
      "--config",
      'developer_instructions="Return a text analysis of the request. Do not use tools, read workspace files, execute commands, modify state, or contact third-party systems. For a NexusOS acceptance canary, use no tools and return only its requested sentinel."',
      "--disable",
      "apps",
      "--disable",
      "auth_elicitation",
      "--disable",
      "browser_use",
      "--disable",
      "browser_use_external",
      "--disable",
      "browser_use_full_cdp_access",
      "--disable",
      "code_mode_host",
      "--disable",
      "computer_use",
      "--disable",
      "goals",
      "--disable",
      "hooks",
      "--disable",
      "image_generation",
      "--disable",
      "in_app_browser",
      "--disable",
      "memories",
      "--disable",
      "multi_agent",
      "--disable",
      "plugin_sharing",
      "--disable",
      "plugins",
      "--disable",
      "remote_plugin",
      "--disable",
      "shell_snapshot",
      "--disable",
      "shell_tool",
      "--disable",
      "skill_search",
      "--disable",
      "skill_mcp_dependency_install",
      "--disable",
      "tool_call_mcp_elicitation",
      "--disable",
      "tool_suggest",
      "--disable",
      "unified_exec",
      "--disable",
      "workspace_dependencies",
      "-",
    ]);
    assertExecutionAdapterBounds(recipe.argv);
    assert.equal(
      recipe.argv.filter(
        (value, index) =>
          value === "--config" &&
          recipe.argv[index + 1] === 'web_search="disabled"',
      ).length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(recipe),
      /workspace-write|danger-full-access|dangerously/u,
    );
  }
});

function assertExecutionAdapterBounds(argv) {
  assert.ok(argv.length >= 1 && argv.length <= 64);
  assert.equal(
    argv.every(
      (value) =>
        Buffer.byteLength(value, "utf8") <= 256 &&
        !/[\0\r\n]/u.test(value),
    ),
    true,
  );
}

test("launch recipes reject unknown versions, paths and extra authority", () => {
  for (const value of [
    {
      engine: "claude_code_cli",
      engineVersion: "unreviewed",
      executableRealPath,
      home,
      scratch,
    },
    {
      engine: "codex_cli",
      engineVersion:
        ENGINE_METADATA_SPECS.codex_cli.supportedVersions[0],
      executableRealPath: "codex",
      home,
      scratch,
    },
    {
      engine: "claude_code_cli",
      engineVersion:
        ENGINE_METADATA_SPECS.claude_code_cli.supportedVersions[0],
      executableRealPath,
      home,
      scratch,
      tools: ["shell"],
    },
    {
      engine: "claude_code_cli",
      engineVersion:
        ENGINE_METADATA_SPECS.claude_code_cli.supportedVersions[0],
      executableRealPath,
      home: "/private/nexus/..",
      scratch,
    },
  ]) {
    assert.throws(
      () => createEngineLaunchRecipe(value),
      EngineLaunchRecipeError,
    );
  }
});
