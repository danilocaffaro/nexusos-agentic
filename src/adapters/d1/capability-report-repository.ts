import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  RUNNER_CAPABILITY_TRUST_DISCLOSURE,
  type RunnerCapabilityReportPage,
  type RunnerCapabilityReportView,
  type RunnerDeclaredCapability,
} from "@/src/contracts/runners";
import { CAPABILITY_REPORT_ID_PATTERN } from "@/src/domain/runners/capability-protocol";
import { RUNNER_TIMESTAMP_PATTERN } from "@/src/domain/runners/runner-protocol";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";

const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const PAGE_SIZE = 50;
const RUNNER_PROJECTION_LIMIT = 100;

export async function listRunnerCapabilityReports(
  identity: RequestIdentity,
  runnerId: string,
  cursorValue?: string,
): Promise<RunnerCapabilityReportPage> {
  await requireWorkspaceMember(identity);
  if (!RUNNER_ID_PATTERN.test(runnerId)) {
    throw new WorkspaceRepositoryError("runner_not_found", 404);
  }
  const cursor = parseCursor(cursorValue);
  const rows = await getD1()
    .prepare(
      `WITH target_runner AS (
         SELECT id
         FROM runners
         WHERE id = ? AND organization_id = ?
         LIMIT 1
       ),
       report_page AS (
         SELECT
           report.report_id, report.platform_os,
           report.platform_arch, report.node_version, report.collected_at,
           report.received_at, report.truncated
         FROM runner_capability_reports report
         INNER JOIN target_runner target ON target.id = report.runner_id
         WHERE report.organization_id = ?
           AND (
             ? IS NULL
             OR report.received_at < ?
             OR (
               report.received_at = ?
               AND report.report_id < ?
             )
           )
         ORDER BY report.received_at DESC, report.report_id DESC
         LIMIT ?
       )
       SELECT
         target.id AS target_runner_id,
         page.report_id, page.platform_os,
         page.platform_arch, page.node_version, page.collected_at,
         page.received_at, page.truncated,
         evidence.position, evidence.capability, evidence.status,
         evidence.detection, evidence.reason_code, evidence.version
       FROM target_runner target
       LEFT JOIN report_page page ON 1 = 1
       LEFT JOIN runner_capability_evidence evidence
         ON evidence.runner_id = target.id
        AND evidence.report_id = page.report_id
       ORDER BY
         page.received_at DESC, page.report_id DESC, evidence.position`,
    )
    .bind(
      runnerId,
      identity.organizationId,
      identity.organizationId,
      cursor?.receivedAt ?? null,
      cursor?.receivedAt ?? null,
      cursor?.receivedAt ?? null,
      cursor?.reportId ?? null,
      PAGE_SIZE + 1,
    )
    .all<CapabilityReportRow>();

  if (rows.results.length === 0) {
    throw new WorkspaceRepositoryError("runner_not_found", 404);
  }
  const reports = groupCapabilityReports(rows.results, Date.now()).map(
    ({ report }) => report,
  );
  const hasNext = reports.length > PAGE_SIZE;
  const page = reports.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    runnerId,
    trustDisclosure: RUNNER_CAPABILITY_TRUST_DISCLOSURE,
    reports: page,
    nextCursor: hasNext && last ? cursorFor(last) : null,
  };
}

export async function loadLatestRunnerCapabilityDeclarations(
  organizationId: string,
  runnerIds: readonly string[],
  nowMs: number,
): Promise<Map<string, RunnerCapabilityReportView>> {
  if (runnerIds.length === 0) return new Map();
  if (runnerIds.length > RUNNER_PROJECTION_LIMIT) {
    throw new Error("Runner capability projection exceeds its fixed limit");
  }
  const selectedRunnerValues = runnerIds.map(() => "(?)").join(", ");
  const rows = await getD1()
    .prepare(
      `WITH selected_runners(runner_id) AS (
         VALUES ${selectedRunnerValues}
       ),
       latest AS (
         SELECT
           selected.runner_id AS target_runner_id,
           (
             SELECT report.rowid
             FROM runner_capability_reports report
             WHERE report.organization_id = ?
               AND report.runner_id = selected.runner_id
             ORDER BY report.received_at DESC, report.report_id DESC
             LIMIT 1
           ) AS report_rowid
         FROM selected_runners selected
       )
       SELECT
         latest.target_runner_id,
         report.report_id, report.platform_os,
         report.platform_arch, report.node_version, report.collected_at,
         report.received_at, report.truncated,
         evidence.position, evidence.capability, evidence.status,
         evidence.detection, evidence.reason_code, evidence.version
       FROM latest
       INNER JOIN runner_capability_reports report
         ON report.rowid = latest.report_rowid
       LEFT JOIN runner_capability_evidence evidence
         ON evidence.runner_id = report.runner_id
        AND evidence.report_id = report.report_id
       ORDER BY latest.target_runner_id, evidence.position`,
    )
    .bind(...runnerIds, organizationId)
    .all<CapabilityReportRow>();

  const reports = groupCapabilityReports(rows.results, nowMs);
  return new Map(
    reports.map(({ runnerId, report }) => [runnerId, report]),
  );
}

function groupCapabilityReports(
  rows: CapabilityReportRow[],
  nowMs: number,
): Array<{ runnerId: string; report: RunnerCapabilityReportView }> {
  const grouped = new Map<
    string,
    {
      runnerId: string;
      report: RunnerCapabilityReportView;
      positions: Set<number>;
    }
  >();
  for (const row of rows) {
    if (!row.report_id || !row.received_at) continue;
    const key = `${row.target_runner_id}|${row.report_id}`;
    let current = grouped.get(key);
    if (!current) {
      current = {
        runnerId: row.target_runner_id,
        report: {
          reportId: row.report_id,
          schemaVersion: 1,
          trust: "hostReported",
          collectedAt: row.collected_at ?? row.received_at,
          receivedAt: row.received_at,
          ageSeconds: Math.max(
            0,
            Math.floor((nowMs - Date.parse(row.received_at)) / 1_000),
          ),
          platform: {
            os: row.platform_os ?? "unknown",
            arch: row.platform_arch ?? "unknown",
            nodeVersion: row.node_version ?? "unknown",
          },
          truncated: row.truncated === 1,
          capabilities: [],
        },
        positions: new Set(),
      };
      grouped.set(key, current);
    }
    if (
      row.position !== null &&
      row.capability &&
      row.status &&
      row.detection &&
      row.reason_code &&
      !current.positions.has(row.position)
    ) {
      current.positions.add(row.position);
      current.report.capabilities.push({
        capability: row.capability,
        status: row.status,
        detection: row.detection,
        reasonCode: row.reason_code,
        ...(row.version ? { version: row.version } : {}),
      } satisfies RunnerDeclaredCapability);
    }
  }
  return [...grouped.values()].map(({ runnerId, report }) => ({
    runnerId,
    report,
  }));
}

function parseCursor(
  value: string | undefined,
): { receivedAt: string; reportId: string } | null {
  if (!value) return null;
  const separator = value.lastIndexOf("|");
  const receivedAt = value.slice(0, separator);
  const reportId = value.slice(separator + 1);
  if (
    separator < 1 ||
    !RUNNER_TIMESTAMP_PATTERN.test(receivedAt) ||
    new Date(Date.parse(receivedAt)).toISOString() !== receivedAt ||
    !CAPABILITY_REPORT_ID_PATTERN.test(reportId)
  ) {
    throw new WorkspaceRepositoryError("invalid_cursor", 400);
  }
  return { receivedAt, reportId };
}

function cursorFor(report: RunnerCapabilityReportView): string {
  return `${report.receivedAt}|${report.reportId}`;
}

type CapabilityReportRow = {
  target_runner_id: string;
  report_id: string | null;
  platform_os: string | null;
  platform_arch: string | null;
  node_version: string | null;
  collected_at: string | null;
  received_at: string | null;
  truncated: number | null;
  position: number | null;
  capability: RunnerDeclaredCapability["capability"] | null;
  status: RunnerDeclaredCapability["status"] | null;
  detection: RunnerDeclaredCapability["detection"] | null;
  reason_code: RunnerDeclaredCapability["reasonCode"] | null;
  version: string | null;
};
