import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson } from "../../src/domain/governance/canonical-json";
import {
  buildRunnerEngineReportAck,
  ENGINE_FRESHNESS_DEFAULT_SECONDS,
  ENGINE_FRESHNESS_MAX_SECONDS,
  ENGINE_FRESHNESS_MIN_SECONDS,
  ENGINE_REPORT_INTERVAL_MAX_SECONDS,
  ENGINE_REPORT_MAX_BYTES,
  isEngineFreshnessSeconds,
  parseRunnerEngineReport,
  parseRunnerEngineReportAck,
  runnerEngineDeclarationHash,
} from "../../src/domain/runners/engine-report-protocol";

const fixtureUrl = new URL(
  "../fixtures/s6-b4/engine-report-v1.json",
  import.meta.url,
);
const bytes = (value: string) => new TextEncoder().encode(value);

test("engine report v1 is a canonical full privacy-safe snapshot", async () => {
  const raw = (await readFile(fixtureUrl, "utf8")).trimEnd();
  const goldenHash = (
    await readFile(
      new URL(
        "../fixtures/s6-b4/engine-report-declaration-sha256.txt",
        import.meta.url,
      ),
      "utf8",
    )
  ).trim();
  const report = parseRunnerEngineReport(bytes(raw));
  assert.ok(report);
  assert.equal(report.engines.length, 2);
  assert.deepEqual(
    report.engines.map((engine) => engine.engine),
    ["claude_code_cli", "codex_cli"],
  );
  assert.equal(canonicalJson(report), raw);
  assert.ok(bytes(raw).byteLength <= ENGINE_REPORT_MAX_BYTES);
  assert.equal(await runnerEngineDeclarationHash(report), goldenHash);
});

test("engine report rejects omitted, reordered, private and partial facts", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const invalid = [
    { ...fixture, path: "/Users/operator/bin/codex" },
    { ...fixture, account: "operator@example.com" },
    { ...fixture, engines: fixture.engines.slice(1) },
    { ...fixture, engines: [...fixture.engines].reverse() },
    {
      ...fixture,
      engines: [
        fixture.engines[0],
        { ...fixture.engines[1], oauthState: "logged-in" },
      ],
    },
    {
      ...fixture,
      engines: [
        fixture.engines[0],
        { ...fixture.engines[1], version: "/Users/operator/.codex" },
      ],
    },
    {
      ...fixture,
      engines: [
        fixture.engines[0],
        { ...fixture.engines[1], version: 123 },
      ],
    },
    {
      ...fixture,
      engines: [
        fixture.engines[0],
        {
          ...fixture.engines[1],
          readiness: "unknown",
          reason: "engine_probe_failed",
        },
      ],
    },
  ];
  for (const value of invalid) {
    assert.equal(
      parseRunnerEngineReport(bytes(canonicalJson(value))),
      undefined,
    );
  }
  assert.equal(
    parseRunnerEngineReport(bytes(`{ "schemaVersion": 1 }`)),
    undefined,
  );
  assert.equal(
    parseRunnerEngineReport(new Uint8Array(ENGINE_REPORT_MAX_BYTES + 1)),
    undefined,
  );
  const canonical = bytes(canonicalJson(fixture));
  assert.equal(
    parseRunnerEngineReport(
      Uint8Array.from([0xef, 0xbb, 0xbf, ...canonical]),
    ),
    undefined,
  );
});

test("declaration hash ignores report identity and collection time", async () => {
  const raw = (await readFile(fixtureUrl, "utf8")).trimEnd();
  const first = parseRunnerEngineReport(bytes(raw));
  assert.ok(first);
  const second = parseRunnerEngineReport(
    bytes(
      canonicalJson({
        ...first,
        collectedAt: "2026-07-27T00:00:00.000Z",
        reportId: `egr_${"1".repeat(32)}`,
      }),
    ),
  );
  assert.ok(second);
  assert.equal(
    await runnerEngineDeclarationHash(first),
    await runnerEngineDeclarationHash(second),
  );
});

test("engine report acknowledgement is exact and freshness-clamped", async () => {
  const golden = JSON.parse(
    await readFile(
      new URL(
        "../fixtures/s6-b4/engine-report-ack-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(isEngineFreshnessSeconds(ENGINE_FRESHNESS_MIN_SECONDS), true);
  assert.equal(isEngineFreshnessSeconds(ENGINE_FRESHNESS_MAX_SECONDS), true);
  assert.equal(isEngineFreshnessSeconds(ENGINE_FRESHNESS_MIN_SECONDS - 1), false);
  const halfHour = buildRunnerEngineReportAck({
    engineFreshnessSeconds: ENGINE_FRESHNESS_MIN_SECONDS,
    receivedAt: "2026-07-26T12:00:00.000Z",
    reportId: `egr_${"0".repeat(32)}`,
  });
  assert.equal(halfHour.nextReportBy, "2026-07-26T12:30:00.000Z");
  const capped = buildRunnerEngineReportAck({
    engineFreshnessSeconds: ENGINE_FRESHNESS_DEFAULT_SECONDS,
    receivedAt: "2026-07-26T12:00:00.000Z",
    reportId: `egr_${"0".repeat(32)}`,
  });
  assert.equal(
    Date.parse(capped.nextReportBy) - Date.parse(capped.receivedAt),
    ENGINE_REPORT_INTERVAL_MAX_SECONDS * 1_000,
  );
  assert.deepEqual(capped, golden);
  assert.equal(canonicalJson(capped), canonicalJson(golden));
  assert.deepEqual(parseRunnerEngineReportAck(capped), capped);
  assert.equal(
    parseRunnerEngineReportAck({ ...capped, account: "private" }),
    undefined,
  );
  assert.throws(
    () =>
      buildRunnerEngineReportAck({
        engineFreshnessSeconds: ENGINE_FRESHNESS_MAX_SECONDS + 1,
        receivedAt: capped.receivedAt,
        reportId: capped.reportId,
      }),
    /Invalid engine report acknowledgement/u,
  );
  assert.equal(
    parseRunnerEngineReportAck({
      ...capped,
      nextReportBy: "2026-07-27T00:00:00.001Z",
    }),
    undefined,
  );
});
