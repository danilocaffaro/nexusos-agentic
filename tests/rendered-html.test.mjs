import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

async function render() {
  const workerPath = fileURLToPath(
    new URL("../dist/server/index.js", import.meta.url),
  );
  const runtime = new Miniflare({
    modules: true,
    scriptPath: workerPath,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "nexus-smoke" },
    serviceBindings: {
      ASSETS: async () => new Response("Not found", { status: 404 }),
    },
  });
  try {
    const response = await runtime.dispatchFetch("http://localhost/", {
      headers: { accept: "text/html" },
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    await runtime.dispose();
  }
}

test("renders the NexusOS vision prototype", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /NexusOS/);
  assert.match(html, /Monte a organização/);
  assert.match(html, /Configurar meu Nexus/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("production worker artifact carries the engine-maintenance cron trigger", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../dist/server/wrangler.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(config.triggers, { crons: ["* * * * *"] });
  const worker = readFileSync(
    new URL("../dist/server/index.js", import.meta.url),
    "utf8",
  );
  assert.match(worker, /scheduled\(_controller, env, ctx\)/u);
  assert.match(
    worker,
    /runScheduledEngineMaintenance\(env\.DB\)/u,
  );
  assert.match(worker, /mode: "scheduled"/u);
  assert.match(worker, /reconcileDuePromptRetention/u);
  assert.match(worker, /reconcileDueEngineRunCreationRetention/u);
});
