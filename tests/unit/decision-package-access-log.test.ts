import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decisionPackageAccessLog } from "../../src/adapters/observability/console-decision-package-access-log";

test("decision package operational log emits metadata only", async () => {
  const calls: unknown[][] = [];
  const original = console.info;
  console.info = (...values: unknown[]) => calls.push(values);
  try {
    await decisionPackageAccessLog.record({
      requestId: "request-1",
      organizationId: "org-1",
      principalId: "principal-1",
      intentId: "intent-1",
      format: "markdown",
      outcome: "success",
      status: 200,
      representationHash: "a".repeat(64),
      byteSize: 42,
    });
  } finally {
    console.info = original;
  }
  assert.equal(calls.length, 1);
  const serialized = calls.flat().join(" ");
  assert.match(serialized, /decision-package-access/);
  assert.doesNotMatch(serialized, /parameters|content|artifact body|secret/i);
});

test("decision package route never passes rendered bytes to the access port", () => {
  const source = readFileSync(
    new URL(
      "../../app/api/governance/intents/[intentId]/decision-package/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const accessFunction = source.slice(
    source.indexOf("function recordAccess"),
    source.indexOf("function routeError"),
  );
  assert.match(accessFunction, /representationHash/);
  assert.match(accessFunction, /byteSize/);
  assert.doesNotMatch(accessFunction, /parameters|markdown|bytes|content:/);
});
