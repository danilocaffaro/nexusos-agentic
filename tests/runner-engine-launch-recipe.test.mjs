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
      PATH: "/private/nexus/bin:/usr/bin:/bin",
      TERM: "dumb",
      TMPDIR: scratch,
    });
    for (const flag of [
      "--print",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--permission-mode",
      "--tools",
      "--strict-mcp-config",
      "--mcp-config",
      "--settings",
      "--system-prompt",
      "--output-format",
    ]) {
      assert.ok(recipe.argv.includes(flag), flag);
    }
    assert.equal(
      recipe.argv[recipe.argv.indexOf("--permission-mode") + 1],
      "dontAsk",
    );
    assert.equal(
      recipe.argv[recipe.argv.indexOf("--tools") + 1],
      "",
    );
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
    assert.deepEqual(recipe.argv.slice(0, 14), [
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
    ]);
    assert.equal(recipe.argv.at(-1), "-");
    for (const feature of [
      "apps",
      "goals",
      "hooks",
      "multi_agent",
      "remote_plugin",
      "shell_snapshot",
      "shell_tool",
    ]) {
      const index = recipe.argv.indexOf(feature);
      assert.equal(recipe.argv[index - 1], "--disable");
    }
    assert.doesNotMatch(
      JSON.stringify(recipe),
      /workspace-write|danger-full-access|dangerously/u,
    );
  }
});

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
  ]) {
    assert.throws(
      () => createEngineLaunchRecipe(value),
      EngineLaunchRecipeError,
    );
  }
});
