import { getD1 } from "@/db";
import {
  cleanupDeclarationOperationalState,
  DeclarationRepositoryError,
  findDeclarationNonceReplay,
  prepareDeclarationNonceInsert,
  prepareDeclarationReplayNonceInsert,
  type SignedDeclarationResult,
} from "@/src/adapters/d1/declaration-nonce";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  RUNNER_CAPABILITY_TRUST_DISCLOSURE,
  type RunnerCapabilityReportPage,
  type RunnerCapabilityReportView,
  type RunnerDeclaredCapability,
} from "@/src/contracts/runners";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import {
  CAPABILITY_REPORT_ID_PATTERN,
  nextCapabilityReceivedAt,
  runnerCapabilityDeclarationHash,
  type RunnerCapabilityReport,
} from "@/src/domain/runners/capability-protocol";
import { RUNNER_TIMESTAMP_PATTERN } from "@/src/domain/runners/runner-protocol";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";

const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const PAGE_SIZE = 50;
const RUNNER_PROJECTION_LIMIT = 100;
const CAPABILITY_APPLY_ATTEMPTS = 3;

export type SignedCapabilityReportResult = SignedDeclarationResult;

type SignedCapabilityReportInput = {
  runner: {
    id: string;
    organizationId: string;
    principalId: string;
  };
  report: RunnerCapabilityReport;
  nonce: string;
  signedRequestHash: string;
  operationRequestHash: string;
  now: string;
};

export async function applyRunnerCapabilityReport(
  input: SignedCapabilityReportInput,
): Promise<SignedCapabilityReportResult> {
  await assertCapabilityRunnerActive(input);
  const nonceReplay = await findCapabilityNonceReplay(input);
  if (nonceReplay) return nonceReplay;
  const stored = await loadStoredCapabilityReport(input);
  if (stored) return replayStoredCapabilityReport(input, stored);

  for (let attempt = 0; attempt < CAPABILITY_APPLY_ATTEMPTS; attempt += 1) {
    const previous = await loadLatestCapabilityReceivedAt(input);
    const receivedAt = nextCapabilityReceivedAt(
      input.now,
      previous?.received_at,
    );
    if (!receivedAt) {
      throw new CapabilityReportRepositoryError(
        "capability_report_failed",
        500,
      );
    }
    const response = canonicalJson({
      receivedAt,
      reportId: input.report.reportId,
    });
    const declarationHash = await runnerCapabilityDeclarationHash(
      input.report,
    );
    const d1 = getD1();
    const statements: D1PreparedStatement[] = [
      d1
        .prepare(
          `INSERT INTO runner_capability_reports (
            organization_id, runner_id, report_id, request_hash,
            declaration_hash, schema_version, platform_os, platform_arch,
            node_version, collected_at, received_at, truncated,
            response_status, response_body, replay_count
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 201, ?, 0)`,
        )
        .bind(
          input.runner.organizationId,
          input.runner.id,
          input.report.reportId,
          input.operationRequestHash,
          declarationHash,
          input.report.platform.os,
          input.report.platform.arch,
          input.report.platform.nodeVersion,
          input.report.collectedAt,
          receivedAt,
          input.report.truncated ? 1 : 0,
          response,
        ),
      ...input.report.capabilities.map((evidence, position) =>
        d1
          .prepare(
            `INSERT INTO runner_capability_evidence (
              runner_id, report_id, position, capability, status,
              detection, reason_code, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.runner.id,
            input.report.reportId,
            position,
            evidence.capability,
            evidence.status,
            evidence.detection,
            evidence.reasonCode,
            evidence.version ?? null,
          ),
      ),
      prepareCapabilityNonceInsert(d1, input, response),
      prepareCapabilityRunnerSeen(d1, input),
    ];
    try {
      await d1.batch(statements);
      await cleanupCapabilityOperationalState(
        input.runner.organizationId,
        input.now,
      ).catch(() => undefined);
      return { status: 201, body: response, replay: false };
    } catch (error) {
      const resolved = await resolveCapabilityApplyFailure(input);
      if (resolved) return resolved;
      if (
        attempt < CAPABILITY_APPLY_ATTEMPTS - 1 &&
        isCapabilityReceiveRace(error)
      ) {
        continue;
      }
      throw mapCapabilityDatabaseError(error);
    }
  }
  throw new CapabilityReportRepositoryError(
    "capability_report_failed",
    500,
  );
}

async function findCapabilityNonceReplay(
  input: SignedCapabilityReportInput,
): Promise<SignedCapabilityReportResult | undefined> {
  return findDeclarationNonceReplay(
    input,
    (code, status) => new CapabilityReportRepositoryError(code, status),
  );
}

async function loadStoredCapabilityReport(
  input: SignedCapabilityReportInput,
): Promise<StoredCapabilityReport | null> {
  return getD1()
    .prepare(
      `SELECT
         report.request_hash, report.response_status, report.response_body,
         report.compacted_at
       FROM runner_capability_reports report
       INNER JOIN runners runner
         ON runner.id = report.runner_id
        AND runner.organization_id = report.organization_id
       INNER JOIN principals principal
         ON principal.id = runner.principal_id
        AND principal.organization_id = runner.organization_id
       WHERE report.organization_id = ?
         AND report.runner_id = ? AND report.report_id = ?
         AND runner.status = 'active'
         AND principal.kind = 'runner' AND principal.status = 'active'
       LIMIT 1`,
    )
    .bind(
      input.runner.organizationId,
      input.runner.id,
      input.report.reportId,
    )
    .first<StoredCapabilityReport>();
}

async function replayStoredCapabilityReport(
  input: SignedCapabilityReportInput,
  stored: StoredCapabilityReport,
): Promise<SignedCapabilityReportResult> {
  assertStoredCapabilityReplay(input, stored);
  const responseBody = stored.response_body;
  if (responseBody === null) {
    throw new CapabilityReportRepositoryError(
      "report_horizon_exceeded",
      410,
    );
  }
  const d1 = getD1();
  try {
    const results = await d1.batch([
      d1
        .prepare(
          `UPDATE runner_capability_reports
           SET replay_count = replay_count + 1
           WHERE organization_id = ? AND runner_id = ? AND report_id = ?
             AND request_hash = ? AND response_body IS NOT NULL
             AND compacted_at IS NULL`,
        )
        .bind(
          input.runner.organizationId,
          input.runner.id,
          input.report.reportId,
          input.operationRequestHash,
        ),
      prepareCapabilityReplayNonceInsert(d1, input, responseBody),
      prepareCapabilityReplayRunnerSeen(d1, input),
    ]);
    if (
      Number(results[0]?.meta.changes) !== 1 ||
      Number(results[1]?.meta.changes) !== 1
    ) {
      return resolveCapabilityReplayMiss(input);
    }
  } catch (error) {
    const nonce = await findCapabilityNonceReplay(input);
    if (nonce) return nonce;
    await assertCapabilityRunnerActive(input);
    const current = await loadStoredCapabilityReport(input);
    if (current) assertStoredCapabilityReplay(input, current);
    throw mapCapabilityDatabaseError(error);
  }
  await cleanupCapabilityOperationalState(
    input.runner.organizationId,
    input.now,
  ).catch(() => undefined);
  return {
    status: stored.response_status,
    body: responseBody,
    replay: true,
  };
}

async function resolveCapabilityReplayMiss(
  input: SignedCapabilityReportInput,
): Promise<SignedCapabilityReportResult> {
  const nonce = await findCapabilityNonceReplay(input);
  if (nonce) return nonce;
  await assertCapabilityRunnerActive(input);
  const current = await loadStoredCapabilityReport(input);
  if (current) assertStoredCapabilityReplay(input, current);
  throw new CapabilityReportRepositoryError(
    "capability_report_failed",
    500,
  );
}

async function resolveCapabilityApplyFailure(
  input: SignedCapabilityReportInput,
): Promise<SignedCapabilityReportResult | undefined> {
  const nonce = await findCapabilityNonceReplay(input);
  if (nonce) return nonce;
  await assertCapabilityRunnerActive(input);
  const stored = await loadStoredCapabilityReport(input);
  return stored
    ? replayStoredCapabilityReport(input, stored)
    : undefined;
}

function assertStoredCapabilityReplay(
  input: SignedCapabilityReportInput,
  stored: StoredCapabilityReport,
): void {
  if (stored.request_hash !== input.operationRequestHash) {
    throw new CapabilityReportRepositoryError("report_conflict", 409);
  }
  if (stored.compacted_at || stored.response_body === null) {
    throw new CapabilityReportRepositoryError(
      "report_horizon_exceeded",
      410,
    );
  }
}

async function assertCapabilityRunnerActive(
  input: SignedCapabilityReportInput,
): Promise<void> {
  const active = await getD1()
    .prepare(
      `SELECT 1 AS active
       FROM runners runner
       INNER JOIN principals principal
         ON principal.id = runner.principal_id
        AND principal.organization_id = runner.organization_id
       WHERE runner.id = ? AND runner.organization_id = ?
         AND runner.principal_id = ?
         AND runner.status = 'active'
         AND principal.kind = 'runner' AND principal.status = 'active'
       LIMIT 1`,
    )
    .bind(
      input.runner.id,
      input.runner.organizationId,
      input.runner.principalId,
    )
    .first<{ active: number }>();
  if (!active) {
    throw new CapabilityReportRepositoryError("runner_rejected", 403);
  }
}

async function loadLatestCapabilityReceivedAt(
  input: SignedCapabilityReportInput,
): Promise<{ received_at: string } | null> {
  return getD1()
    .prepare(
      `SELECT received_at
       FROM runner_capability_reports
       WHERE organization_id = ? AND runner_id = ?
       ORDER BY received_at DESC, report_id DESC
       LIMIT 1`,
    )
    .bind(input.runner.organizationId, input.runner.id)
    .first<{ received_at: string }>();
}

function prepareCapabilityNonceInsert(
  d1: D1Database,
  input: SignedCapabilityReportInput,
  responseBody: string,
): D1PreparedStatement {
  return prepareDeclarationNonceInsert(d1, input, responseBody);
}

function prepareCapabilityReplayNonceInsert(
  d1: D1Database,
  input: SignedCapabilityReportInput,
  responseBody: string,
): D1PreparedStatement {
  return prepareDeclarationReplayNonceInsert(
    d1,
    input,
    responseBody,
    {
      kind: "capability",
      reportId: input.report.reportId,
      operationRequestHash: input.operationRequestHash,
    },
  );
}

function prepareCapabilityRunnerSeen(
  d1: D1Database,
  input: SignedCapabilityReportInput,
): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE runners
       SET last_seen_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'active'
         AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    )
    .bind(
      input.now,
      input.now,
      input.runner.id,
      input.runner.organizationId,
      input.now,
    );
}

function prepareCapabilityReplayRunnerSeen(
  d1: D1Database,
  input: SignedCapabilityReportInput,
): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE runners
       SET last_seen_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'active'
         AND (last_seen_at IS NULL OR last_seen_at < ?)
         AND EXISTS (
           SELECT 1 FROM runner_capability_reports report
           WHERE report.organization_id = runners.organization_id
             AND report.runner_id = runners.id
             AND report.report_id = ?
             AND report.request_hash = ?
             AND report.response_body IS NOT NULL
             AND report.compacted_at IS NULL
         )`,
    )
    .bind(
      input.now,
      input.now,
      input.runner.id,
      input.runner.organizationId,
      input.now,
      input.report.reportId,
      input.operationRequestHash,
    );
}

async function cleanupCapabilityOperationalState(
  organizationId: string,
  now: string,
): Promise<void> {
  await cleanupDeclarationOperationalState(organizationId, now);
}

function isCapabilityReceiveRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    /invalid_capability_report/iu.test(error.message)
  );
}

function mapCapabilityDatabaseError(
  error: unknown,
): CapabilityReportRepositoryError {
  if (
    error instanceof Error &&
    /capability_nonce_already_exists|UNIQUE constraint failed:\s*runner_capability_nonces/iu.test(
      error.message,
    )
  ) {
    return new CapabilityReportRepositoryError("nonce_reused", 409);
  }
  if (
    error instanceof Error &&
    /capability_report_already_exists|UNIQUE constraint failed:\s*runner_capability_reports/iu.test(
      error.message,
    )
  ) {
    return new CapabilityReportRepositoryError("report_conflict", 409);
  }
  return new CapabilityReportRepositoryError(
    "capability_report_failed",
    500,
  );
}

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
    if (!row.report_id || !row.collected_at || !row.received_at) continue;
    const key = `${row.target_runner_id}|${row.report_id}`;
    let current = grouped.get(key);
    if (!current) {
      current = {
        runnerId: row.target_runner_id,
        report: {
          reportId: row.report_id,
          schemaVersion: 1,
          trust: "hostReported",
          collectedAt: row.collected_at,
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

type StoredCapabilityReport = {
  request_hash: string;
  response_status: number;
  response_body: string | null;
  compacted_at: string | null;
};

export class CapabilityReportRepositoryError extends DeclarationRepositoryError {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code, status);
    this.name = "CapabilityReportRepositoryError";
  }
}
