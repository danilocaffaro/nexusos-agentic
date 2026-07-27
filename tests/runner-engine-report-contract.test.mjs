import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  encodeEngineReport,
  engineDeclarationHash,
  ENGINE_REPORT_MAX_BYTES,
  parseEngineReportAck,
  parseEngineReportBody,
} from "../runner/engine-report-contract.mjs";
import { ENGINE_REPORT_LIMITS } from "../runner/engine-report-limits.mjs";
import serverLimits from "../src/contracts/engine-report-limits.json" with {
  type: "json",
};

const fixtureUrl = new URL(
  "./fixtures/s6-b4/engine-report-v1.json",
  import.meta.url,
);

test("runner accepts the shared canonical engine report fixture", async () => {
  const raw = (await readFile(fixtureUrl, "utf8")).trimEnd();
  const goldenHash = (
    await readFile(
      new URL(
        "./fixtures/s6-b4/engine-report-declaration-sha256.txt",
        import.meta.url,
      ),
      "utf8",
    )
  ).trim();
  const report = parseEngineReportBody(raw);
  assert.ok(report);
  assert.equal(encodeEngineReport(report).toString("utf8"), raw);
  assert.equal(engineDeclarationHash(report), goldenHash);
  assert.ok(Buffer.byteLength(raw) <= ENGINE_REPORT_MAX_BYTES);
  assert.deepEqual(ENGINE_REPORT_LIMITS, serverLimits);
});

test("runner rejects reordered, private, inconsistent and noncanonical reports", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const invalid = [
    { ...fixture, engines: fixture.engines.slice(1) },
    { ...fixture, engines: [...fixture.engines].reverse() },
    { ...fixture, home: "/Users/operator" },
    {
      ...fixture,
      engines: [
        fixture.engines[0],
        { ...fixture.engines[1], readiness: "unknown" },
      ],
    },
    {
      ...fixture,
      engines: [
        fixture.engines[0],
        { ...fixture.engines[1], version: 123 },
      ],
    },
  ];
  for (const value of invalid) {
    assert.equal(parseEngineReportBody(JSON.stringify(value)), undefined);
  }
  assert.equal(parseEngineReportBody(`{ "schemaVersion": 1 }`), undefined);
  const canonical = encodeEngineReport(fixture);
  assert.equal(
    parseEngineReportBody(
      Uint8Array.from([0xef, 0xbb, 0xbf, ...canonical]),
    ),
    undefined,
  );
});

test("runner accepts only the exact acknowledgement for its report", async () => {
  const reportId = `egr_${"0".repeat(32)}`;
  const ack = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/s6-b4/engine-report-ack-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(parseEngineReportAck(ack, reportId), ack);
  assert.equal(
    parseEngineReportAck({ ...ack, reportId: `egr_${"1".repeat(32)}` }, reportId),
    undefined,
  );
  assert.equal(
    parseEngineReportAck({ ...ack, email: "operator@example.com" }, reportId),
    undefined,
  );
  assert.equal(
    parseEngineReportAck(
      { ...ack, nextReportBy: "2026-07-27T00:00:00.001Z" },
      reportId,
    ),
    undefined,
  );
});
