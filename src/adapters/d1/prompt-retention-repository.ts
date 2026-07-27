import { getD1 } from "@/db";
import { assertCanonicalTimestamp } from "@/src/domain/runners/deadline-reconciliation";
import {
  isPromptRetentionEligible,
  MUTATION_PROMPT_RETENTION_LIMIT,
  promptRetentionCutoff,
  promptRetentionHealthCutoff,
  SCHEDULED_PROMPT_RETENTION_LIMIT,
} from "@/src/domain/runners/prompt-retention";

export type PromptRetentionMode = "mutation" | "scheduled";

export type PromptRetentionFailure = {
  runId: string;
  code: string;
};

export type PromptRetentionResult = {
  mode: PromptRetentionMode;
  limit: 25 | 100;
  observedAt: string;
  scanned: number;
  erased: number;
  skipped: number;
  truncated: boolean;
  failures: PromptRetentionFailure[];
};

export type PromptRetentionHealth = {
  overdue: boolean;
};

export async function reconcileDuePromptRetention(input: {
  mode: PromptRetentionMode;
  now?: string;
}): Promise<PromptRetentionResult> {
  const observedAt = input.now ?? new Date().toISOString();
  assertCanonicalTimestamp(observedAt);
  const cutoff = promptRetentionCutoff(observedAt);
  const limit =
    input.mode === "mutation"
      ? MUTATION_PROMPT_RETENTION_LIMIT
      : SCHEDULED_PROMPT_RETENTION_LIMIT;
  const selected = await listDuePrompts(cutoff, limit + 1);
  const selectedExcerpts = await listDueEngineExcerpts(cutoff, limit + 1);
  const truncated =
    selected.length > limit || selectedExcerpts.length > limit;
  const candidates = selected.slice(0, limit);
  const excerptCandidates = selectedExcerpts.slice(0, limit);
  const result: PromptRetentionResult = {
    mode: input.mode,
    limit,
    observedAt,
    scanned: candidates.length + excerptCandidates.length,
    erased: 0,
    skipped: 0,
    truncated,
    failures: [],
  };

  for (const candidate of candidates) {
    let outcome: "erased" | "skipped" | { code: string };
    try {
      if (
        !isPromptRetentionEligible({
          observedAt,
          recordedAt: candidate.recorded_at,
          status: candidate.status,
        })
      ) {
        outcome = { code: "prompt_retention_candidate_invalid" };
      } else {
        outcome = await erasePromptCandidate(candidate, observedAt, cutoff);
      }
    } catch {
      outcome = { code: "prompt_retention_candidate_invalid" };
    }

    if (outcome === "erased") result.erased += 1;
    else if (outcome === "skipped") result.skipped += 1;
    else result.failures.push({ runId: candidate.run_id, code: outcome.code });
  }
  for (const candidate of excerptCandidates) {
    let outcome: "erased" | "skipped" | { code: string };
    try {
      if (
        !isPromptRetentionEligible({
          observedAt,
          recordedAt: candidate.recorded_at,
          status: candidate.status,
        })
      ) {
        outcome = { code: "engine_excerpt_retention_candidate_invalid" };
      } else {
        outcome = await eraseEngineExcerptCandidate(
          candidate,
          observedAt,
          cutoff,
        );
      }
    } catch {
      outcome = { code: "engine_excerpt_retention_candidate_invalid" };
    }

    if (outcome === "erased") result.erased += 1;
    else if (outcome === "skipped") result.skipped += 1;
    else result.failures.push({ runId: candidate.run_id, code: outcome.code });
  }
  return result;
}

export async function promptRetentionHealth(
  now = new Date().toISOString(),
): Promise<PromptRetentionHealth> {
  const cutoff = promptRetentionHealthCutoff(now);
  const row = await getD1()
    .prepare(
      `SELECT 1 AS overdue
       WHERE EXISTS (
         SELECT 1
         FROM runs run
         INNER JOIN run_prompts prompt
           ON prompt.run_id = run.id
          AND prompt.organization_id = run.organization_id
         WHERE run.kind = 'engine_prompt'
           AND run.status IN ('completed', 'canceled', 'expired')
           AND run.recorded_at <= ?
           AND prompt.erased_at IS NULL
       ) OR EXISTS (
         SELECT 1
         FROM runs run
         INNER JOIN run_engine_excerpts excerpt
           ON excerpt.run_id = run.id
          AND excerpt.organization_id = run.organization_id
         WHERE run.kind = 'engine_prompt'
           AND run.status IN ('completed', 'canceled', 'expired')
           AND run.recorded_at <= ?
           AND excerpt.erased_at IS NULL
       )
       LIMIT 1`,
    )
    .bind(cutoff, cutoff)
    .first<{ overdue: number }>();
  return { overdue: row?.overdue === 1 };
}

export async function listLiveProtectedPayloadKeyIds(): Promise<string[]> {
  const result = await getD1()
    .prepare(
      `SELECT key_id
       FROM run_prompts
       WHERE erased_at IS NULL AND key_id IS NOT NULL
       UNION
       SELECT key_id
       FROM run_engine_excerpts
       WHERE erased_at IS NULL AND key_id IS NOT NULL
       ORDER BY key_id`,
    )
    .all<{ key_id: string }>();
  return result.results.map((row) => row.key_id);
}

async function listDuePrompts(
  cutoff: string,
  limit: number,
): Promise<PromptRetentionCandidate[]> {
  const result = await getD1()
    .prepare(
      `SELECT
         run.id AS run_id,
         run.organization_id,
         run.status,
         run.recorded_at,
         prompt.prompt_ref
       FROM runs run
       INNER JOIN run_prompts prompt
         ON prompt.run_id = run.id
        AND prompt.organization_id = run.organization_id
       WHERE run.kind = 'engine_prompt'
         AND run.status IN ('completed', 'canceled', 'expired')
         AND run.recorded_at <= ?
         AND prompt.erased_at IS NULL
       ORDER BY run.recorded_at, run.id
       LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<PromptRetentionCandidate>();
  return result.results;
}

async function erasePromptCandidate(
  candidate: PromptRetentionCandidate,
  erasedAt: string,
  cutoff: string,
): Promise<"erased" | "skipped" | { code: string }> {
  try {
    const result = await getD1()
      .prepare(
        `UPDATE run_prompts
         SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL,
             erased_at = ?
         WHERE run_id = ? AND organization_id = ?
           AND prompt_ref = ?
           AND erased_at IS NULL
           AND key_id IS NOT NULL
           AND iv IS NOT NULL
           AND ciphertext IS NOT NULL
           AND tag IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM runs run
             WHERE run.id = run_prompts.run_id
               AND run.organization_id = run_prompts.organization_id
               AND run.kind = 'engine_prompt'
               AND run.status IN ('completed', 'canceled', 'expired')
               AND run.recorded_at = ?
               AND run.recorded_at <= ?
           )`,
      )
      .bind(
        erasedAt,
        candidate.run_id,
        candidate.organization_id,
        candidate.prompt_ref,
        candidate.recorded_at,
        cutoff,
      )
      .run();
    const changes = Number(result.meta.changes);
    return changes === 1 ? "erased" : "skipped";
  } catch {
    return { code: "prompt_retention_failed" };
  }
}

async function listDueEngineExcerpts(
  cutoff: string,
  limit: number,
): Promise<EngineExcerptRetentionCandidate[]> {
  const result = await getD1()
    .prepare(
      `SELECT
         run.id AS run_id,
         run.organization_id,
         run.status,
         run.recorded_at,
         excerpt.excerpt_ref
       FROM runs run
       INNER JOIN run_engine_excerpts excerpt
         ON excerpt.run_id = run.id
        AND excerpt.organization_id = run.organization_id
       WHERE run.kind = 'engine_prompt'
         AND run.status IN ('completed', 'canceled', 'expired')
         AND run.recorded_at <= ?
         AND excerpt.erased_at IS NULL
       ORDER BY run.recorded_at, run.id
       LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<EngineExcerptRetentionCandidate>();
  return result.results;
}

async function eraseEngineExcerptCandidate(
  candidate: EngineExcerptRetentionCandidate,
  erasedAt: string,
  cutoff: string,
): Promise<"erased" | "skipped" | { code: string }> {
  try {
    const result = await getD1()
      .prepare(
        `UPDATE run_engine_excerpts
         SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL,
             erased_at = ?
         WHERE run_id = ? AND organization_id = ?
           AND excerpt_ref = ?
           AND erased_at IS NULL
           AND key_id IS NOT NULL
           AND iv IS NOT NULL
           AND ciphertext IS NOT NULL
           AND tag IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM runs run
             WHERE run.id = run_engine_excerpts.run_id
               AND run.organization_id =
                 run_engine_excerpts.organization_id
               AND run.kind = 'engine_prompt'
               AND run.status IN ('completed', 'canceled', 'expired')
               AND run.recorded_at = ?
               AND run.recorded_at <= ?
           )`,
      )
      .bind(
        erasedAt,
        candidate.run_id,
        candidate.organization_id,
        candidate.excerpt_ref,
        candidate.recorded_at,
        cutoff,
      )
      .run();
    const changes = Number(result.meta.changes);
    return changes === 1 ? "erased" : "skipped";
  } catch {
    return { code: "engine_excerpt_retention_failed" };
  }
}

type PromptRetentionCandidate = {
  run_id: string;
  organization_id: string;
  status: string;
  recorded_at: string;
  prompt_ref: string;
};

type EngineExcerptRetentionCandidate = {
  run_id: string;
  organization_id: string;
  status: string;
  recorded_at: string;
  excerpt_ref: string;
};
