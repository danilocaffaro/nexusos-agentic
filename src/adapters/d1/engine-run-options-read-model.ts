import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  EXECUTION_ENGINE_NAMES,
  type EngineProbeReadiness,
  type EngineProbeStatus,
  type ExecutionEngineName,
} from "@/src/contracts/execution-engines";
import {
  ENGINE_RUN_OPTIONS_MAX_RUNNERS,
  ENGINE_RUN_OPTIONS_SCHEMA_VERSION,
  ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE,
  type EngineRunOptionsView,
} from "@/src/contracts/engine-run-options";
import {
  evaluateEngineInventoryEligibility,
  toEngineRunOption,
  type ConfiguredEngineAdmissionPolicySnapshot,
  type EngineInventoryReportSnapshot,
} from "@/src/domain/runners/engine-inventory-eligibility";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";

const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const ENGINE_ROWS_PER_RUNNER = EXECUTION_ENGINE_NAMES.length;

export async function listEngineRunOptions(
  identity: RequestIdentity,
): Promise<EngineRunOptionsView> {
  await requireWorkspaceMember(identity);

  // This server timestamp is the sole time authority for the whole response.
  const evaluatedAt = new Date().toISOString();
  const result = await getD1()
    .prepare(ENGINE_RUN_OPTIONS_QUERY)
    .bind(
      identity.organizationId,
      ENGINE_RUN_OPTIONS_MAX_RUNNERS + 1,
      identity.organizationId,
      identity.organizationId,
    )
    .all<EngineRunOptionRow>();
  const runners = groupRunnerRows(result.results);
  const selected = runners.slice(0, ENGINE_RUN_OPTIONS_MAX_RUNNERS);
  const options = selected.flatMap((runner) =>
    EXECUTION_ENGINE_NAMES.map((engine) => {
      const row = runner.byEngine.get(engine);
      if (!row) throw optionsFailure();
      const inventory = evaluateEngineInventoryEligibility({
        requestedEngine: engine,
        now: evaluatedAt,
        configuredPolicy: toConfiguredPolicy(row),
        engineReports: toEngineReports(row),
      });
      return toEngineRunOption(
        {
          id: row.runner_id,
          name: row.runner_name,
          state: row.runner_state,
        },
        inventory,
      );
    }),
  );

  if (options.length > ENGINE_RUN_OPTIONS_MAX_RUNNERS * ENGINE_ROWS_PER_RUNNER) {
    throw optionsFailure();
  }
  return deepFreeze({
    schemaVersion: ENGINE_RUN_OPTIONS_SCHEMA_VERSION,
    trustDisclosure: ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE,
    truncated: runners.length > ENGINE_RUN_OPTIONS_MAX_RUNNERS,
    options,
  });
}

function groupRunnerRows(
  rows: EngineRunOptionRow[],
): Array<{
  runnerId: string;
  enrolledAt: string;
  byEngine: Map<ExecutionEngineName, EngineRunOptionRow>;
}> {
  const grouped = new Map<
    string,
    {
      runnerId: string;
      enrolledAt: string;
      byEngine: Map<ExecutionEngineName, EngineRunOptionRow>;
    }
  >();
  for (const row of rows) {
    if (
      !RUNNER_ID_PATTERN.test(row.runner_id) ||
      typeof row.runner_name !== "string" ||
      row.runner_name.length < 1 ||
      row.runner_name.length > 120 ||
      !isCanonicalTimestamp(row.enrolled_at) ||
      !isExecutionEngineName(row.requested_engine) ||
      !["active", "inactive"].includes(row.runner_state)
    ) {
      throw optionsFailure();
    }
    const runner = grouped.get(row.runner_id) ?? {
      runnerId: row.runner_id,
      enrolledAt: row.enrolled_at,
      byEngine: new Map<ExecutionEngineName, EngineRunOptionRow>(),
    };
    if (
      runner.enrolledAt !== row.enrolled_at ||
      runner.byEngine.has(row.requested_engine)
    ) {
      throw optionsFailure();
    }
    runner.byEngine.set(row.requested_engine, row);
    grouped.set(row.runner_id, runner);
  }
  const runners = [...grouped.values()];
  if (
    rows.length !== runners.length * ENGINE_ROWS_PER_RUNNER ||
    runners.some(
      (runner) => runner.byEngine.size !== ENGINE_ROWS_PER_RUNNER,
    )
  ) {
    throw optionsFailure();
  }
  return runners;
}

function toConfiguredPolicy(
  row: EngineRunOptionRow,
): ConfiguredEngineAdmissionPolicySnapshot | null {
  if (row.policy_version === null) return null;
  return {
    version: row.policy_version,
    engineFreshnessSeconds: row.engine_freshness_seconds ?? Number.NaN,
    versionRecorded: row.policy_version_recorded === 1,
  };
}

function toEngineReports(
  row: EngineRunOptionRow,
): EngineInventoryReportSnapshot[] {
  if (row.report_id === null) return [];
  return [{
    reportId: row.report_id,
    receivedAt: row.received_at ?? "",
    evidenceCount: row.evidence_count,
    engine: row.reported_engine,
    status: row.engine_status,
    readiness: row.engine_readiness,
    reason: row.engine_reason,
    version: row.engine_version,
  }];
}

function isExecutionEngineName(
  value: unknown,
): value is ExecutionEngineName {
  return (
    typeof value === "string" &&
    EXECUTION_ENGINE_NAMES.includes(value as ExecutionEngineName)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function optionsFailure(): WorkspaceRepositoryError {
  return new WorkspaceRepositoryError(
    "engine_run_options_unavailable",
    500,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const ENGINE_RUN_OPTIONS_QUERY = `
  WITH target_runners AS (
    SELECT
      runner.id AS runner_id,
      runner.display_name AS runner_name,
      runner.enrolled_at,
      CASE
        WHEN runner.status = 'active'
         AND principal.kind = 'runner'
         AND principal.status = 'active'
        THEN 'active'
        ELSE 'inactive'
      END AS runner_state
    FROM runners AS runner
    LEFT JOIN principals AS principal
      ON principal.id = runner.principal_id
     AND principal.organization_id = runner.organization_id
    WHERE runner.organization_id = ?
    ORDER BY runner.enrolled_at DESC, runner.id
    LIMIT ?
  ),
  requested_engines(requested_engine, engine_order) AS (
    VALUES ('claude_code_cli', 0), ('codex_cli', 1)
  )
  SELECT
    runner.runner_id,
    runner.runner_name,
    runner.enrolled_at,
    runner.runner_state,
    requested.requested_engine,
    policy.version AS policy_version,
    policy.engine_freshness_seconds,
    CASE
      WHEN policy.organization_id IS NULL THEN NULL
      WHEN EXISTS (
        SELECT 1
        FROM runner_admission_policy_versions AS recorded
        WHERE recorded.organization_id = policy.organization_id
          AND recorded.version = policy.version
          AND recorded.engine_freshness_seconds =
            policy.engine_freshness_seconds
      ) THEN 1
      ELSE 0
    END AS policy_version_recorded,
    report.report_id,
    report.received_at,
    (
      SELECT COUNT(*)
      FROM runner_engine_evidence AS complete
      WHERE complete.runner_id = report.runner_id
        AND complete.report_id = report.report_id
    ) AS evidence_count,
    evidence.engine AS reported_engine,
    evidence.status AS engine_status,
    evidence.readiness AS engine_readiness,
    evidence.reason AS engine_reason,
    evidence.version AS engine_version
  FROM target_runners AS runner
  CROSS JOIN requested_engines AS requested
  LEFT JOIN runner_admission_policies AS policy
    ON policy.organization_id = ?
  LEFT JOIN runner_engine_reports AS report
    ON report.rowid = (
      SELECT latest.rowid
      FROM runner_engine_reports AS latest
      WHERE latest.organization_id = ?
        AND latest.runner_id = runner.runner_id
      ORDER BY latest.received_at DESC, latest.report_id DESC
      LIMIT 1
    )
  LEFT JOIN runner_engine_evidence AS evidence
    ON evidence.runner_id = report.runner_id
   AND evidence.report_id = report.report_id
   AND evidence.engine = requested.requested_engine
  ORDER BY runner.enrolled_at DESC, runner.runner_id, requested.engine_order`;

type EngineRunOptionRow = {
  runner_id: string;
  runner_name: string;
  enrolled_at: string;
  runner_state: "active" | "inactive";
  requested_engine: ExecutionEngineName;
  policy_version: number | null;
  engine_freshness_seconds: number | null;
  policy_version_recorded: number | null;
  report_id: string | null;
  received_at: string | null;
  evidence_count: number;
  reported_engine: ExecutionEngineName | null;
  engine_status: EngineProbeStatus | null;
  engine_readiness: EngineProbeReadiness | null;
  engine_reason: string | null;
  engine_version: string | null;
};
