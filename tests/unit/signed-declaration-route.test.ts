import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CAPABILITY_REPORT_MAX_BYTES } from "../../src/domain/runners/capability-protocol";
import { ENGINE_REPORT_MAX_BYTES } from "../../src/domain/runners/engine-report-protocol";

test("signed declaration mirrors share one transport bound", () => {
  assert.equal(CAPABILITY_REPORT_MAX_BYTES, 4_096);
  assert.equal(ENGINE_REPORT_MAX_BYTES, CAPABILITY_REPORT_MAX_BYTES);
  const source = readFileSync(
    new URL(
      "../../src/adapters/http/signed-declaration-route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /SIGNED_DECLARATION_MAX_BYTES = CAPABILITY_REPORT_MAX_BYTES/u,
  );
  assert.match(
    source,
    /SIGNED_DECLARATION_MAX_BYTES !== ENGINE_REPORT_MAX_BYTES/u,
  );
});
