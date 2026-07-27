import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mapped system principals stay outside human and agent collaboration surfaces", async () => {
  const repositoryRoot = new URL("../../", import.meta.url);
  for (const relative of [
    "src/adapters/d1/presence-repository.ts",
    "src/adapters/d1/work-repository.ts",
    "src/adapters/d1/collaboration-repository.ts",
    "src/adapters/d1/collaboration-lifecycle-repository.ts",
  ]) {
    const source = await readFile(new URL(relative, repositoryRoot), "utf8");
    assert.match(
      source,
      /NOT EXISTS \(\s*SELECT 1\s*FROM organization_system_principals system_principal[\s\S]*?system_principal\.principal_id = principal(?:s)?\.id\s*\)/u,
      `${relative} must exclude the exact immutable system mapping`,
    );
  }
});
