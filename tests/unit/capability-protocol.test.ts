import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson } from "../../src/domain/governance/canonical-json";
import {
  CAPABILITY_REPORT_INTERVAL_MS,
  DEFAULT_CAPABILITY_FRESHNESS_MS,
  isCapabilityReportFresh,
  MAX_CAPABILITY_FRESHNESS_MS,
  parseRunnerCapabilityReport,
  runnerCapabilityDeclarationHash,
} from "../../src/domain/runners/capability-protocol";

const fixtureUrl = new URL(
  "../fixtures/s6-b3/capability-report-v1.json",
  import.meta.url,
);
const bytes = (value: string) => new TextEncoder().encode(value);

test("capability report v1 fixture is canonical, bounded and strictly typed", async () => {
  const raw = (await readFile(fixtureUrl, "utf8")).trimEnd();
  const report = parseRunnerCapabilityReport(bytes(raw));
  assert.ok(report);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.capabilities.length, 2);
  assert.equal(report.capabilities[0]?.capability, "node_permission_model");
  assert.equal(report.capabilities[1]?.capability, "bubblewrap");
  assert.match(await runnerCapabilityDeclarationHash(report), /^[0-9a-f]{64}$/u);
});

test("capability reports reject unknown, private, duplicated and noncanonical data", async () => {
  const raw = await readFile(fixtureUrl, "utf8");
  const fixture = JSON.parse(raw);
  const invalid = [
    { ...fixture, hostname: "operator-laptop" },
    { ...fixture, schemaVersion: 2 },
    { ...fixture, reportId: "cap_NOT_CANONICAL" },
    { ...fixture, capabilities: [] },
    {
      ...fixture,
      platform: { ...fixture.platform, username: "operator" },
    },
    {
      ...fixture,
      capabilities: [
        fixture.capabilities[0],
        fixture.capabilities[0],
      ],
    },
    {
      ...fixture,
      capabilities: [...fixture.capabilities].reverse(),
    },
    {
      ...fixture,
      capabilities: [
        {
          ...fixture.capabilities[0],
          version: "x".repeat(65),
        },
      ],
    },
    {
      ...fixture,
      capabilities: [
        {
          ...fixture.capabilities[0],
          version: "0.11.0 /home/alice/.config/gh/hosts.yml",
        },
      ],
    },
    {
      ...fixture,
      capabilities: [
        {
          ...fixture.capabilities[0],
          version: "user=alice",
        },
      ],
    },
    {
      ...fixture,
      platform: {
        ...fixture.platform,
        nodeVersion: "v22.14.0 user=alice",
      },
    },
    {
      ...fixture,
      capabilities: [
        {
          ...fixture.capabilities[0],
          status: "verified",
        },
      ],
    },
  ];
  for (const value of invalid) {
    assert.equal(
      parseRunnerCapabilityReport(bytes(canonicalJson(value))),
      undefined,
    );
  }
  assert.equal(
    parseRunnerCapabilityReport(bytes(`{ "schemaVersion": 1 }`)),
    undefined,
  );
  assert.equal(
    parseRunnerCapabilityReport(bytes("x".repeat(4_097))),
    undefined,
  );
});

test("declaration hash ignores report identity and host collection time", async () => {
  const raw = (await readFile(fixtureUrl, "utf8")).trimEnd();
  const first = parseRunnerCapabilityReport(bytes(raw));
  assert.ok(first);
  const second = parseRunnerCapabilityReport(
    bytes(
      canonicalJson({
        ...first,
        collectedAt: "2026-07-27T00:00:00.000Z",
        reportId: `cap_${"1".repeat(32)}`,
      }),
    ),
  );
  assert.ok(second);
  assert.equal(
    await runnerCapabilityDeclarationHash(first),
    await runnerCapabilityDeclarationHash(second),
  );
});

test("12-hour reports retain margin at the exact 24-hour freshness edge", () => {
  assert.equal(CAPABILITY_REPORT_INTERVAL_MS * 2, DEFAULT_CAPABILITY_FRESHNESS_MS);
  const receivedAt = "2026-07-26T12:00:00.000Z";
  const receivedAtMs = Date.parse(receivedAt);
  assert.equal(
    isCapabilityReportFresh({
      receivedAt,
      nowMs: receivedAtMs + DEFAULT_CAPABILITY_FRESHNESS_MS,
    }),
    true,
  );
  assert.equal(
    isCapabilityReportFresh({
      receivedAt,
      nowMs: receivedAtMs + DEFAULT_CAPABILITY_FRESHNESS_MS + 1,
    }),
    false,
  );
  assert.equal(
    isCapabilityReportFresh({
      receivedAt: "2026-07-26T12:00:00.000Z",
      nowMs: receivedAtMs - 1,
    }),
    false,
  );
  assert.equal(
    isCapabilityReportFresh({
      receivedAt: "2026-07-26T12:00:00",
      nowMs: receivedAtMs,
    }),
    false,
  );
  assert.equal(
    isCapabilityReportFresh({
      receivedAt,
      nowMs: receivedAtMs,
      maxAgeMs: MAX_CAPABILITY_FRESHNESS_MS + 1,
    }),
    false,
  );
});
