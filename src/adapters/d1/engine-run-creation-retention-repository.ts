import { assertCanonicalTimestamp } from "@/src/domain/runners/deadline-reconciliation";

export const MUTATION_ENGINE_RUN_CREATION_RETENTION_LIMIT = 20;
export const SCHEDULED_ENGINE_RUN_CREATION_RETENTION_LIMIT = 100;

export type EngineRunCreationRetentionMode = "mutation" | "scheduled";

export type EngineRunCreationRetentionResult = {
  mode: EngineRunCreationRetentionMode;
  limit: 20 | 100;
  observedAt: string;
  scanned: number;
  deleted: number;
  skipped: number;
  truncated: boolean;
};

export async function reconcileDueEngineRunCreationRetention(
  d1: D1Database,
  input: {
    mode: EngineRunCreationRetentionMode;
    now?: string;
  },
): Promise<EngineRunCreationRetentionResult> {
  const observedAt = input.now ?? new Date().toISOString();
  assertCanonicalTimestamp(observedAt);
  const limit =
    input.mode === "mutation"
      ? MUTATION_ENGINE_RUN_CREATION_RETENTION_LIMIT
      : SCHEDULED_ENGINE_RUN_CREATION_RETENTION_LIMIT;
  const selected = await d1
    .prepare(
      `SELECT organization_id, requested_by, creation_id, retain_until
       FROM engine_run_creations
       WHERE state = 'confirmed_not_created'
         AND retain_until <= ?
       ORDER BY retain_until, creation_id
       LIMIT ?`,
    )
    .bind(observedAt, limit + 1)
    .all<EngineRunCreationRetentionCandidate>();
  const truncated = selected.results.length > limit;
  const candidates = selected.results.slice(0, limit);
  if (candidates.length === 0) {
    return {
      mode: input.mode,
      limit,
      observedAt,
      scanned: 0,
      deleted: 0,
      skipped: 0,
      truncated,
    };
  }

  const outcomes = await d1.batch(
    candidates.map((candidate) =>
      d1
        .prepare(
          `DELETE FROM engine_run_creations
           WHERE organization_id = ?
             AND requested_by = ?
             AND creation_id = ?
             AND state = 'confirmed_not_created'
             AND retain_until = ?
             AND retain_until <= ?`,
        )
        .bind(
          candidate.organization_id,
          candidate.requested_by,
          candidate.creation_id,
          candidate.retain_until,
          observedAt,
        ),
    ),
  );
  const deleted = outcomes.reduce(
    (total, outcome) => total + Number(outcome.meta.changes),
    0,
  );
  return {
    mode: input.mode,
    limit,
    observedAt,
    scanned: candidates.length,
    deleted,
    skipped: candidates.length - deleted,
    truncated,
  };
}

type EngineRunCreationRetentionCandidate = {
  organization_id: string;
  requested_by: string;
  creation_id: string;
  retain_until: string;
};
