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
  RUNNER_ENGINE_TRUST_DISCLOSURE,
  type RunnerDeclaredEngine,
  type RunnerEngineReportPage,
  type RunnerEngineReportView,
} from "@/src/contracts/engine-inventory";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import {
  nextCapabilityReceivedAt,
} from "@/src/domain/runners/capability-protocol";
import {
  buildRunnerEngineReportAck,
  ENGINE_FRESHNESS_DEFAULT_SECONDS,
  ENGINE_REPORT_ID_PATTERN,
  isEngineFreshnessSeconds,
  parseRunnerEngineReport,
  runnerEngineDeclarationHash,
  type RunnerEngineReport,
} from "@/src/domain/runners/engine-report-protocol";
import { RUNNER_TIMESTAMP_PATTERN } from "@/src/domain/runners/runner-protocol";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";

const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const PAGE_SIZE = 50;
const ENGINE_APPLY_ATTEMPTS = 3;

type SignedEngineReportInput = {
  runner: {
    id: string;
    organizationId: string;
    principalId: string;
  };
  report: RunnerEngineReport;
  nonce: string;
  signedRequestHash: string;
  operationRequestHash: string;
  now: string;
};

export async function applyRunnerEngineReport(
  input: SignedEngineReportInput,
): Promise<SignedDeclarationResult> {
  await assertEngineRunnerActive(input);
  const nonceReplay = await findEngineNonceReplay(input);
  if (nonceReplay) return nonceReplay;
  const stored = await loadStoredEngineReport(input);
  if (stored) return replayStoredEngineReport(input, stored);

  for (let attempt = 0; attempt < ENGINE_APPLY_ATTEMPTS; attempt += 1) {
    const [previous, engineFreshnessSeconds] = await Promise.all([
      loadLatestEngineReceivedAt(input),
      loadEngineFreshnessSeconds(input.runner.organizationId),
    ]);
    const receivedAt = nextCapabilityReceivedAt(
      input.now,
      previous?.received_at,
    );
    if (!receivedAt || !isEngineFreshnessSeconds(engineFreshnessSeconds)) {
      throw engineFailure();
    }
    let response: string;
    try {
      response = canonicalJson(
        buildRunnerEngineReportAck({
          engineFreshnessSeconds,
          receivedAt,
          reportId: input.report.reportId,
        }),
      );
    } catch {
      throw engineFailure();
    }
    const declarationHash = await runnerEngineDeclarationHash(input.report);
    const d1 = getD1();
    const statements: D1PreparedStatement[] = [
      d1
        .prepare(
          `INSERT INTO runner_engine_reports (
            organization_id, runner_id, report_id, request_hash,
            declaration_hash, schema_version, collected_at, received_at,
            truncated, response_status, response_body, replay_count
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 201, ?, 0)`,
        )
        .bind(
          input.runner.organizationId,
          input.runner.id,
          input.report.reportId,
          input.operationRequestHash,
          declarationHash,
          input.report.collectedAt,
          receivedAt,
          input.report.truncated ? 1 : 0,
          response,
        ),
      ...input.report.engines.map((evidence, position) =>
        d1
          .prepare(
            `INSERT INTO runner_engine_evidence (
              runner_id, report_id, position, engine, status, readiness,
              reason, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.runner.id,
            input.report.reportId,
            position,
            evidence.engine,
            evidence.status,
            evidence.readiness,
            evidence.reason,
            evidence.version ?? null,
          ),
      ),
      prepareDeclarationNonceInsert(d1, input, response),
      prepareEngineRunnerSeen(d1, input),
    ];
    try {
      await d1.batch(statements);
      await cleanupDeclarationOperationalState(
        input.runner.organizationId,
        input.now,
      ).catch(() => undefined);
      return { status: 201, body: response, replay: false };
    } catch (error) {
      const resolved = await resolveEngineApplyFailure(input);
      if (resolved) return resolved;
      if (
        attempt < ENGINE_APPLY_ATTEMPTS - 1 &&
        isEngineReceiveRace(error)
      ) {
        continue;
      }
      throw mapEngineDatabaseError(error);
    }
  }
  throw engineFailure();
}

async function findEngineNonceReplay(
  input: SignedEngineReportInput,
): Promise<SignedDeclarationResult | undefined> {
  return findDeclarationNonceReplay(
    input,
    (code, status) => new EngineReportRepositoryError(code, status),
  );
}

async function loadStoredEngineReport(
  input: SignedEngineReportInput,
): Promise<StoredEngineReport | null> {
  return getD1()
    .prepare(
      `SELECT
         report.request_hash, report.response_status, report.response_body,
         report.compacted_at
       FROM runner_engine_reports report
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
    .first<StoredEngineReport>();
}

async function replayStoredEngineReport(
  input: SignedEngineReportInput,
  stored: StoredEngineReport,
): Promise<SignedDeclarationResult> {
  assertStoredEngineReplay(input, stored);
  const responseBody = stored.response_body;
  if (responseBody === null) {
    throw new EngineReportRepositoryError(
      "report_horizon_exceeded",
      410,
    );
  }
  const d1 = getD1();
  try {
    const results = await d1.batch([
      d1
        .prepare(
          `UPDATE runner_engine_reports
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
      prepareDeclarationReplayNonceInsert(
        d1,
        input,
        responseBody,
        {
          kind: "engine",
          reportId: input.report.reportId,
          operationRequestHash: input.operationRequestHash,
        },
      ),
      prepareEngineReplayRunnerSeen(d1, input),
    ]);
    if (
      Number(results[0]?.meta.changes) !== 1 ||
      Number(results[1]?.meta.changes) !== 1
    ) {
      return resolveEngineReplayMiss(input);
    }
  } catch (error) {
    const nonce = await findEngineNonceReplay(input);
    if (nonce) return nonce;
    await assertEngineRunnerActive(input);
    const current = await loadStoredEngineReport(input);
    if (current) assertStoredEngineReplay(input, current);
    throw mapEngineDatabaseError(error);
  }
  await cleanupDeclarationOperationalState(
    input.runner.organizationId,
    input.now,
  ).catch(() => undefined);
  return {
    status: stored.response_status,
    body: responseBody,
    replay: true,
  };
}

async function resolveEngineReplayMiss(
  input: SignedEngineReportInput,
): Promise<SignedDeclarationResult> {
  const nonce = await findEngineNonceReplay(input);
  if (nonce) return nonce;
  await assertEngineRunnerActive(input);
  const current = await loadStoredEngineReport(input);
  if (current) assertStoredEngineReplay(input, current);
  throw engineFailure();
}

async function resolveEngineApplyFailure(
  input: SignedEngineReportInput,
): Promise<SignedDeclarationResult | undefined> {
  const nonce = await findEngineNonceReplay(input);
  if (nonce) return nonce;
  await assertEngineRunnerActive(input);
  const stored = await loadStoredEngineReport(input);
  return stored ? replayStoredEngineReport(input, stored) : undefined;
}

function assertStoredEngineReplay(
  input: SignedEngineReportInput,
  stored: StoredEngineReport,
): void {
  if (stored.request_hash !== input.operationRequestHash) {
    throw new EngineReportRepositoryError("report_conflict", 409);
  }
  if (stored.compacted_at || stored.response_body === null) {
    throw new EngineReportRepositoryError(
      "report_horizon_exceeded",
      410,
    );
  }
}

async function assertEngineRunnerActive(
  input: SignedEngineReportInput,
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
    throw new EngineReportRepositoryError("runner_rejected", 403);
  }
}

async function loadLatestEngineReceivedAt(
  input: SignedEngineReportInput,
): Promise<{ received_at: string } | null> {
  return getD1()
    .prepare(
      `SELECT received_at
       FROM runner_engine_reports
       WHERE organization_id = ? AND runner_id = ?
       ORDER BY received_at DESC, report_id DESC
       LIMIT 1`,
    )
    .bind(input.runner.organizationId, input.runner.id)
    .first<{ received_at: string }>();
}

async function loadEngineFreshnessSeconds(
  organizationId: string,
): Promise<number> {
  const row = await getD1()
    .prepare(
      `SELECT engine_freshness_seconds
       FROM runner_admission_policies
       WHERE organization_id = ?
       LIMIT 1`,
    )
    .bind(organizationId)
    .first<{ engine_freshness_seconds: number }>();
  return row?.engine_freshness_seconds ?? ENGINE_FRESHNESS_DEFAULT_SECONDS;
}

function prepareEngineRunnerSeen(
  d1: D1Database,
  input: SignedEngineReportInput,
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

function prepareEngineReplayRunnerSeen(
  d1: D1Database,
  input: SignedEngineReportInput,
): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE runners
       SET last_seen_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'active'
         AND (last_seen_at IS NULL OR last_seen_at < ?)
         AND EXISTS (
           SELECT 1 FROM runner_engine_reports report
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

function isEngineReceiveRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    /invalid_engine_report/iu.test(error.message)
  );
}

function mapEngineDatabaseError(
  error: unknown,
): EngineReportRepositoryError {
  if (
    error instanceof Error &&
    /capability_nonce_already_exists|UNIQUE constraint failed:\s*runner_capability_nonces/iu.test(
      error.message,
    )
  ) {
    return new EngineReportRepositoryError("nonce_reused", 409);
  }
  if (
    error instanceof Error &&
    /engine_report_already_exists|UNIQUE constraint failed:\s*runner_engine_reports/iu.test(
      error.message,
    )
  ) {
    return new EngineReportRepositoryError("report_conflict", 409);
  }
  return engineFailure();
}

export async function listRunnerEngineReports(
  identity: RequestIdentity,
  runnerId: string,
  cursorValue?: string,
): Promise<RunnerEngineReportPage> {
  await requireWorkspaceMember(identity);
  if (!RUNNER_ID_PATTERN.test(runnerId)) {
    throw new WorkspaceRepositoryError("runner_not_found", 404);
  }
  const cursor = parseEngineCursor(cursorValue);
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
           report.report_id, report.collected_at, report.received_at,
           report.truncated
         FROM runner_engine_reports report
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
         page.report_id, page.collected_at, page.received_at, page.truncated,
         evidence.position, evidence.engine, evidence.status,
         evidence.readiness, evidence.reason, evidence.version
       FROM target_runner target
       LEFT JOIN report_page page ON 1 = 1
       LEFT JOIN runner_engine_evidence evidence
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
    .all<EngineReportRow>();

  if (rows.results.length === 0) {
    throw new WorkspaceRepositoryError("runner_not_found", 404);
  }
  const reports = groupEngineReports(rows.results, Date.now());
  const hasNext = reports.length > PAGE_SIZE;
  const page = reports.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    runnerId,
    trustDisclosure: RUNNER_ENGINE_TRUST_DISCLOSURE,
    reports: page,
    nextCursor: hasNext && last ? engineCursorFor(last) : null,
  };
}

function groupEngineReports(
  rows: EngineReportRow[],
  nowMs: number,
): RunnerEngineReportView[] {
  const grouped = new Map<
    string,
    {
      collectedAt: string;
      engines: RunnerDeclaredEngine[];
      receivedAt: string;
      reportId: string;
      truncated: boolean;
    }
  >();
  for (const row of rows) {
    if (!row.report_id || !row.collected_at || !row.received_at) continue;
    let current = grouped.get(row.report_id);
    if (!current) {
      current = {
        collectedAt: row.collected_at,
        engines: [],
        receivedAt: row.received_at,
        reportId: row.report_id,
        truncated: row.truncated === 1,
      };
      grouped.set(row.report_id, current);
    }
    if (
      row.position !== null &&
      row.engine &&
      row.status &&
      row.readiness &&
      row.reason &&
      current.engines.length === row.position
    ) {
      current.engines.push({
        engine: row.engine,
        status: row.status,
        readiness: row.readiness,
        reason: row.reason,
        ...(row.version ? { version: row.version } : {}),
      });
    }
  }

  return [...grouped.values()].map((stored) => {
    const report = parseRunnerEngineReport(
      new TextEncoder().encode(
        canonicalJson({
          collectedAt: stored.collectedAt,
          engines: stored.engines,
          reportId: stored.reportId,
          schemaVersion: 1,
          truncated: stored.truncated,
        }),
      ),
    );
    if (!report) throw engineFailure();
    return {
      ageSeconds: Math.max(
        0,
        Math.floor((nowMs - Date.parse(stored.receivedAt)) / 1_000),
      ),
      collectedAt: report.collectedAt,
      engines: report.engines,
      receivedAt: stored.receivedAt,
      reportId: report.reportId,
      schemaVersion: 1,
      trust: "hostReported",
      truncated: report.truncated,
    };
  });
}

function parseEngineCursor(
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
    !ENGINE_REPORT_ID_PATTERN.test(reportId)
  ) {
    throw new WorkspaceRepositoryError("invalid_cursor", 400);
  }
  return { receivedAt, reportId };
}

function engineCursorFor(report: RunnerEngineReportView): string {
  return `${report.receivedAt}|${report.reportId}`;
}

function engineFailure(): EngineReportRepositoryError {
  return new EngineReportRepositoryError("engine_report_failed", 500);
}

type EngineReportRow = {
  target_runner_id: string;
  report_id: string | null;
  collected_at: string | null;
  received_at: string | null;
  truncated: number | null;
  position: number | null;
  engine: RunnerDeclaredEngine["engine"] | null;
  status: RunnerDeclaredEngine["status"] | null;
  readiness: RunnerDeclaredEngine["readiness"] | null;
  reason: RunnerDeclaredEngine["reason"] | null;
  version: string | null;
};

type StoredEngineReport = {
  request_hash: string;
  response_status: number;
  response_body: string | null;
  compacted_at: string | null;
};

export class EngineReportRepositoryError extends DeclarationRepositoryError {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code, status);
    this.name = "EngineReportRepositoryError";
  }
}
