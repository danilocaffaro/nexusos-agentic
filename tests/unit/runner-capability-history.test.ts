import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RunnerCapabilityHistory,
  capabilityHistoryUrl,
  mergeCapabilityReportPages,
  readCapabilityReportPage,
} from "../../app/runner-capability-history";
import type { RunnerCapabilityReportView } from "../../src/contracts/runners";

const report = (
  reportId: string,
  receivedAt: string,
): RunnerCapabilityReportView => ({
  reportId,
  schemaVersion: 1,
  trust: "hostReported",
  collectedAt: "2026-07-25T11:59:00.000Z",
  receivedAt,
  ageSeconds: 60,
  platform: {
    os: "darwin",
    arch: "arm64",
    nodeVersion: "v22.14.0",
  },
  truncated: false,
  capabilities: [
    {
      capability: "node_permission_model",
      status: "available",
      detection: "node_flag",
      reasonCode: "none",
      version: "v22.14.0",
    },
  ],
});

test("renders history as an explicit on-demand action", () => {
  const html = renderToStaticMarkup(
    createElement(RunnerCapabilityHistory, {
      runnerId: "rnr_1234567890abcdef1234567890abcdef",
      runnerName: "Mac Studio",
    }),
  );
  assert.match(html, /Histórico de declarações/u);
  assert.match(html, /REGISTRO IMUTÁVEL · LEITURA SOB DEMANDA/u);
  assert.match(html, /Carregar histórico/u);
  assert.match(html, /horário de coleta.*afirmação do host/u);
  assert.match(html, /role="status"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.doesNotMatch(html, /elegível|atestado|sandboxed/iu);
});

test("merges cursor pages without duplicates or reordering", () => {
  const first = report("cap_first", "2026-07-25T12:03:00.000Z");
  const second = report("cap_second", "2026-07-25T12:02:00.000Z");
  const third = report("cap_third", "2026-07-25T12:01:00.000Z");
  assert.deepEqual(
    mergeCapabilityReportPages(
      [first, second],
      [second, third, first],
    ).map((item) => item.reportId),
    ["cap_first", "cap_second", "cap_third"],
  );
});

test("preserves and encodes the server cursor as an opaque value", () => {
  assert.equal(
    capabilityHistoryUrl(
      "rnr_123/with delimiter",
      "server+cursor=/do-not-parse?",
    ),
    "/api/runners/rnr_123%2Fwith%20delimiter/capability-reports?cursor=server%2Bcursor%3D%2Fdo-not-parse%3F",
  );
});

test("accepts only the expected runner and a complete report shape", () => {
  const page = {
    runnerId: "rnr_expected",
    trustDisclosure: "host supplied",
    reports: [report("cap_1", "2026-07-25T12:00:00.000Z")],
    nextCursor: "opaque",
  };
  assert.equal(readCapabilityReportPage(page, "rnr_expected"), page);
  assert.equal(readCapabilityReportPage(page, "rnr_other"), null);
  assert.equal(
    readCapabilityReportPage(
      { ...page, nextCursor: "" },
      "rnr_expected",
    ),
    null,
  );
  assert.equal(
    readCapabilityReportPage(
      {
        ...page,
        reports: [
          {
            ...page.reports[0],
            capabilities: [
              {
                ...page.reports[0].capabilities[0],
                status: "invented",
              },
            ],
          },
        ],
      },
      "rnr_expected",
    ),
    null,
  );
});

test("invalidates superseded and collapsed history requests", async () => {
  const source = await readFile(
    new URL("../../app/runner-capability-history.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /controllerRef\.current\?\.abort\(\)/u);
  assert.match(source, /requestId !== requestIdRef\.current/u);
  assert.match(source, /signal: controller\.signal/u);
  assert.match(source, /actionRef\.current\?\.focus\(\)/u);

  const parent = await readFile(
    new URL("../../app/runners-view.tsx", import.meta.url),
    "utf8",
  );
  assert.match(parent, /detailOpen && \(/u);
});
