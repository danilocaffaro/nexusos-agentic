import { getD1 } from "@/db";
import { env } from "cloudflare:workers";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  RUNNER_CAPABILITY_TRUST_DISCLOSURE,
  RUNNER_TRUST_DISCLOSURE,
  RUNNER_TRUST_PROFILE,
  type Runner,
  type RunnerEnrollment,
  type RunnerEnrollmentToken,
  type RunnerHeartbeat,
  type RunnerRegistry,
} from "@/src/contracts/runners";
import type {
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import { hashCanonical } from "@/src/domain/governance/crypto";
import { appendLedgerEntry } from "@/src/domain/governance/ledger";
import { deriveRunnerLiveness } from "@/src/domain/runners/liveness";
import {
  configuredRunnerAudience,
  deriveRunnerIdentity,
  generateRunnerToken,
  hashRunnerToken,
  publicKeyFingerprint,
} from "@/src/domain/runners/runner-protocol";
import { isRunEventSequenceConflict } from "@/src/domain/runners/lease-protocol";
import {
  requireWorkspaceMember,
  requireWorkspaceOwner,
} from "./workspace-repository";
import { loadLatestRunnerCapabilityDeclarations } from "./capability-report-repository";

const TOKEN_TTL_MS = 15 * 60 * 1000;
const HEARTBEAT_REPLAY_TTL_MS = 15 * 60 * 1000;
const LEDGER_RETRY_LIMIT = 5;

export async function issueRunnerEnrollmentToken(
  identity: RequestIdentity,
  input: Record<string, unknown>,
): Promise<RunnerEnrollmentToken> {
  await requireWorkspaceOwner(identity);
  const displayName = requiredDisplayName(input.displayName);
  const token = generateRunnerToken();
  const tokenHash = await hashRunnerToken(token);
  if (!tokenHash) throw new Error("Generated a non-canonical runner token");
  const id = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(issuedAt) + enrollmentTokenTtlMs(),
  ).toISOString();
  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    kind: "runner_token.issued",
    actorId: identity.id,
    occurredAt: issuedAt,
    payloadHash: await hashCanonical({
      tokenId: id,
      expiresAt,
      trustProfile: RUNNER_TRUST_PROFILE,
    }),
    payloadRef: tokenRef(id),
  };

  await executeLedgerBatch(identity.organizationId, event, (entry) => {
    const d1 = getD1();
    return [
      d1
        .prepare(
          `INSERT INTO runner_enrollment_tokens (
            id, organization_id, token_hash, issued_by, display_name,
            issued_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          identity.organizationId,
          tokenHash,
          identity.id,
          displayName,
          issuedAt,
          expiresAt,
          issuedAt,
          issuedAt,
        ),
      prepareLedgerInsert(d1, entry, {
        existsSql:
          "SELECT 1 FROM runner_enrollment_tokens WHERE id = ? AND organization_id = ?",
        bindings: [id, identity.organizationId],
      }),
    ];
  });
  return { tokenId: id, token, expiresAt };
}

export async function revokeRunnerEnrollmentToken(
  identity: RequestIdentity,
  tokenId: string,
): Promise<{ tokenId: string; revokedAt: string }> {
  await requireWorkspaceOwner(identity);
  const current = await getD1()
    .prepare(
      `SELECT revoked_at, consumed_runner_id
       FROM runner_enrollment_tokens
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(tokenId, identity.organizationId)
    .first<{ revoked_at: string | null; consumed_runner_id: string | null }>();
  if (!current) throw new RunnerRepositoryError("runner_token_not_found", 404);
  if (current.revoked_at) {
    return { tokenId, revokedAt: current.revoked_at };
  }
  if (current.consumed_runner_id) {
    throw new RunnerRepositoryError("runner_token_consumed", 409);
  }

  const revokedAt = new Date().toISOString();
  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    kind: "runner_token.revoked",
    actorId: identity.id,
    occurredAt: revokedAt,
    payloadHash: await hashCanonical({ tokenId, state: "revoked" }),
    payloadRef: tokenRef(tokenId),
  };
  await executeLedgerBatch(identity.organizationId, event, (entry) => {
    const d1 = getD1();
    return [
      d1
        .prepare(
          `UPDATE runner_enrollment_tokens
           SET revoked_at = ?, revoked_by = ?, updated_at = ?
           WHERE id = ? AND organization_id = ?
             AND revoked_at IS NULL AND consumed_runner_id IS NULL`,
        )
        .bind(
          revokedAt,
          identity.id,
          revokedAt,
          tokenId,
          identity.organizationId,
        ),
      prepareLedgerInsert(d1, entry, {
        existsSql:
          "SELECT 1 FROM runner_enrollment_tokens WHERE id = ? AND organization_id = ? AND revoked_at = ? AND revoked_by = ?",
        bindings: [
          tokenId,
          identity.organizationId,
          revokedAt,
          identity.id,
        ],
        uniquePayloadKind: true,
      }),
    ];
  });

  const persisted = await getD1()
    .prepare(
      `SELECT revoked_at FROM runner_enrollment_tokens
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(tokenId, identity.organizationId)
    .first<{ revoked_at: string | null }>();
  if (!persisted?.revoked_at) {
    throw new RunnerRepositoryError("runner_token_conflict", 409);
  }
  return { tokenId, revokedAt: persisted.revoked_at };
}

export async function enrollRunner(input: {
  tokenHash: string;
  publicKey: string;
  displayName: string;
  now: string;
}): Promise<RunnerEnrollment> {
  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const token = await loadEnrollmentToken(input.tokenHash);
    if (!token) throw enrollmentRejected();
    const identity = await deriveRunnerIdentity(input.tokenHash, input.publicKey);
    if (token.display_name !== input.displayName) throw enrollmentRejected();
    if (token.consumed_runner_id && token.consumed_runner_id !== identity.runnerId) {
      throw enrollmentRejected();
    }
    if (
      !token.consumed_runner_id &&
      (token.revoked_at !== null || token.expires_at <= input.now)
    ) {
      throw enrollmentRejected();
    }

    const fingerprint = await publicKeyFingerprint(input.publicKey);
    if (!fingerprint) throw enrollmentRejected();
    const enrolledAt = token.consumed_at ?? input.now;
    const event: LedgerEvent = {
      id: crypto.randomUUID(),
      organizationId: token.organization_id,
      kind: "runner.enrolled",
      actorId: identity.principalId,
      occurredAt: enrolledAt,
      payloadHash: await hashCanonical({
        runnerId: identity.runnerId,
        principalId: identity.principalId,
        tokenId: token.id,
        publicKeyFingerprint: fingerprint,
        trustProfile: RUNNER_TRUST_PROFILE,
      }),
      payloadRef: runnerRef(identity.runnerId),
    };
    const entry = await nextLedgerEntry(token.organization_id, event);
    try {
      const results = await getD1().batch(
        prepareEnrollmentBatch({
          token,
          identity,
          publicKey: input.publicKey,
          displayName: input.displayName,
          enrolledAt,
          now: input.now,
          entry,
        }),
      );
      const persisted = await loadEnrollmentResult(token.id);
      if (
        persisted?.consumed_runner_id === identity.runnerId &&
        persisted.public_key === input.publicKey
      ) {
        return {
          runnerId: identity.runnerId,
          principalId: identity.principalId,
          organizationId: token.organization_id,
          enrolledAt: persisted.enrolled_at,
          trustProfile: RUNNER_TRUST_PROFILE,
        };
      }
      if (
        persisted &&
        (persisted.consumed_runner_id ||
          persisted.revoked_at ||
          persisted.expires_at <= input.now)
      ) {
        throw enrollmentRejected();
      }
      if (results.every((result) => Number(result.meta.changes) === 0)) {
        await ledgerRetryJitter();
        continue;
      }
    } catch (error) {
      if (isRunnerIdentityConflict(error)) throw enrollmentRejected();
      if (isLedgerSequenceConflict(error)) {
        await ledgerRetryJitter();
        continue;
      }
      throw mapRunnerDatabaseError(error);
    }
  }
  throw new RunnerRepositoryError("conflict_retry", 409);
}

export async function listRunners(
  identity: RequestIdentity,
): Promise<RunnerRegistry> {
  await requireWorkspaceMember(identity);
  const audience = configuredRunnerAudience(env.NEXUS_RUNNER_AUDIENCE);
  if (!audience) {
    throw new RunnerRepositoryError("runner_audience_unconfigured", 503);
  }
  const nowMs = Date.now();
  const result = await getD1()
    .prepare(
      `SELECT
         id, principal_id, display_name, public_key, trust_profile, status,
         enrolled_at, last_seen_at, revoked_at
       FROM runners
       WHERE organization_id = ?
       ORDER BY enrolled_at DESC, id
       LIMIT 100`,
    )
    .bind(identity.organizationId)
    .all<RunnerRow>();
  const declarations = await loadLatestRunnerCapabilityDeclarations(
    identity.organizationId,
    result.results.map((runner) => runner.id),
    nowMs,
  );
  const runners = await Promise.all(
    result.results.map(async (row): Promise<Runner> => ({
      id: row.id,
      organizationId: identity.organizationId,
      principalId: row.principal_id,
      displayName: row.display_name,
      publicKey: row.public_key,
      publicKeyFingerprint:
        (await publicKeyFingerprint(row.public_key)) ?? "unavailable",
      trustProfile: RUNNER_TRUST_PROFILE,
      trustDisclosure: RUNNER_TRUST_DISCLOSURE,
      status: row.status,
      liveness: deriveRunnerLiveness({
        status: row.status,
        ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
        nowMs,
      }),
      enrolledAt: row.enrolled_at,
      ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
      declaredCapabilities: declarations.get(row.id) ?? null,
    })),
  );
  return {
    runners,
    audience,
    trustDisclosure: RUNNER_TRUST_DISCLOSURE,
    capabilities: {
      identity: "real",
      heartbeat: "real",
      leases: "real",
      durableReplay: "real",
      capabilityProfiles: "roadmap",
      execution: "roadmap",
      sandbox: "roadmap",
      streaming: "roadmap",
    },
    capabilityDisclosure: RUNNER_CAPABILITY_TRUST_DISCLOSURE,
  };
}

export async function revokeRunner(
  identity: RequestIdentity,
  runnerId: string,
): Promise<{ runnerId: string; revokedAt: string }> {
  await requireWorkspaceOwner(identity);
  const requestedAt = new Date().toISOString();
  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    kind: "runner.revoked",
    actorId: identity.id,
    occurredAt: requestedAt,
    payloadHash: await hashCanonical({ runnerId, state: "revoked" }),
    payloadRef: runnerRef(runnerId),
  };

  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const current = await getD1()
      .prepare(
        `SELECT principal_id, status, revoked_at
         FROM runners
         WHERE id = ? AND organization_id = ?
         LIMIT 1`,
      )
      .bind(runnerId, identity.organizationId)
      .first<{
        principal_id: string;
        status: "active" | "revoked";
        revoked_at: string | null;
      }>();
    if (!current) throw new RunnerRepositoryError("runner_not_found", 404);
    if (current.status === "revoked" && !current.revoked_at) {
      throw new RunnerRepositoryError("runner_conflict", 409);
    }
    const activeLeases = await loadActiveRunnerLeases(
      runnerId,
      identity.organizationId,
    );
    if (activeLeases.length > 1) {
      throw new RunnerRepositoryError("runner_conflict", 409);
    }
    if (
      current.status === "revoked" &&
      current.revoked_at &&
      activeLeases.length === 0
    ) {
      return { runnerId, revokedAt: current.revoked_at };
    }

    const leaseEndedAt =
      current.status === "active" ? requestedAt : new Date().toISOString();
    const d1 = getD1();
    const statements: D1PreparedStatement[] = [];
    if (current.status === "active") {
      statements.push(
        d1
          .prepare(
            `UPDATE principals
             SET status = 'disabled', updated_at = ?
             WHERE id = ? AND organization_id = ?
               AND kind = 'runner' AND status = 'active'`,
          )
          .bind(
            requestedAt,
            current.principal_id,
            identity.organizationId,
          ),
      );
    }
    const lease = activeLeases[0];
    if (lease) {
      statements.push(
        d1
          .prepare(
            `UPDATE run_leases
             SET status = 'revoked', ended_at = ?,
                 ended_reason = 'runner_revoked', updated_at = ?
             WHERE id = ? AND run_id = ? AND runner_id = ?
               AND status = 'active'`,
          )
          .bind(
            leaseEndedAt,
            leaseEndedAt,
            lease.id,
            lease.run_id,
            runnerId,
          ),
        d1
          .prepare(
            `INSERT INTO run_events (
              organization_id, run_id, sequence, kind, actor_id, fence,
              occurred_at, metadata_json
            )
            SELECT ?, ?, ?, 'lease.revoked', ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM run_leases
              WHERE id = ? AND run_id = ? AND runner_id = ?
                AND status = 'revoked' AND ended_at = ?
            )`,
          )
          .bind(
            identity.organizationId,
            lease.run_id,
            lease.event_sequence + 1,
            identity.id,
            lease.fence,
            leaseEndedAt,
            canonicalJson({
              leaseId: lease.id,
              runnerId,
              fence: lease.fence,
              reason: "runner_revoked",
            }),
            lease.id,
            lease.run_id,
            runnerId,
            leaseEndedAt,
          ),
      );
    }
    if (current.status === "active") {
      const entry = await nextLedgerEntry(identity.organizationId, event);
      statements.push(
        d1
          .prepare(
            `UPDATE runners
             SET status = 'revoked', revoked_at = ?, revoked_by = ?,
                 updated_at = ?
             WHERE id = ? AND organization_id = ? AND status = 'active'
               AND EXISTS (
                 SELECT 1 FROM principals
                 WHERE id = ? AND organization_id = ?
                   AND kind = 'runner' AND status = 'disabled'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM run_leases
                 WHERE runner_id = ? AND organization_id = ?
                   AND status = 'active'
               )`,
          )
          .bind(
            requestedAt,
            identity.id,
            requestedAt,
            runnerId,
            identity.organizationId,
            current.principal_id,
            identity.organizationId,
            runnerId,
            identity.organizationId,
          ),
        prepareRequiredRunnerLedgerInsert(d1, entry),
      );
    }
    try {
      await d1.batch(statements);
    } catch (error) {
      if (!isRunnerRevocationRace(error)) {
        throw mapRunnerDatabaseError(error);
      }
      await ledgerRetryJitter();
      if (attempt === LEDGER_RETRY_LIMIT - 1) {
        throw new RunnerRepositoryError("conflict_retry", 409);
      }
      continue;
    }
    const persisted = await loadRunnerRevocationState(
      runnerId,
      identity.organizationId,
    );
    if (
      persisted?.status === "revoked" &&
      persisted.revoked_at &&
      persisted.active_lease_count === 0
    ) {
      return { runnerId, revokedAt: persisted.revoked_at };
    }
    throw new RunnerRepositoryError("runner_conflict", 409);
  }
  throw new RunnerRepositoryError("conflict_retry", 409);
}

export async function requireActiveRunner(
  runnerId: string,
): Promise<{
  id: string;
  organizationId: string;
  principalId: string;
  publicKey: string;
}> {
  const runner = await getD1()
    .prepare(
      `SELECT
         runner.id, runner.organization_id, runner.principal_id,
         runner.public_key
       FROM runners runner
       INNER JOIN principals principal
         ON principal.id = runner.principal_id
        AND principal.organization_id = runner.organization_id
       WHERE runner.id = ?
         AND runner.status = 'active'
         AND principal.kind = 'runner'
         AND principal.status = 'active'
       LIMIT 1`,
    )
    .bind(runnerId)
    .first<{
      id: string;
      organization_id: string;
      principal_id: string;
      public_key: string;
    }>();
  if (!runner) throw new RunnerRepositoryError("runner_authentication_failed", 403);
  return {
    id: runner.id,
    organizationId: runner.organization_id,
    principalId: runner.principal_id,
    publicKey: runner.public_key,
  };
}

export async function recordRunnerHeartbeat(input: {
  runnerId: string;
  organizationId: string;
  nonce: string;
  requestHash: string;
  now: string;
}): Promise<{ body: string; replay: boolean }> {
  const body = canonicalJson({
    nextHeartbeatSeconds: 30,
    observedAt: input.now,
    status: "active",
  } satisfies RunnerHeartbeat);
  const expiresAt = new Date(
    Date.parse(input.now) + HEARTBEAT_REPLAY_TTL_MS,
  ).toISOString();
  const d1 = getD1();
  try {
    await d1.batch([
      d1
        .prepare(
          `INSERT INTO runner_heartbeat_nonces (
            organization_id, runner_id, nonce, request_hash, response_status,
            response_body, occurred_at, expires_at
          ) VALUES (?, ?, ?, ?, 200, ?, ?, ?)`,
        )
        .bind(
          input.organizationId,
          input.runnerId,
          input.nonce,
          input.requestHash,
          body,
          input.now,
          expiresAt,
        ),
      d1
        .prepare(
          `UPDATE runners
           SET last_seen_at = ?, updated_at = ?
           WHERE id = ? AND organization_id = ? AND status = 'active'
             AND (last_seen_at IS NULL OR last_seen_at < ?)
             AND EXISTS (
               SELECT 1 FROM principals
               WHERE id = runners.principal_id
                 AND organization_id = runners.organization_id
                 AND kind = 'runner' AND status = 'active'
             )`,
        )
        .bind(
          input.now,
          input.now,
          input.runnerId,
          input.organizationId,
          input.now,
        ),
    ]);
    await cleanupRunnerNonces(input.organizationId, input.now).catch(
      () => undefined,
    );
    return { body, replay: false };
  } catch (error) {
    if (!isNonceConflict(error)) throw mapRunnerDatabaseError(error);
  }

  await requireActiveRunner(input.runnerId);
  const replay = await d1
    .prepare(
      `SELECT request_hash, response_body
       FROM runner_heartbeat_nonces
       WHERE runner_id = ? AND nonce = ?
       LIMIT 1`,
    )
    .bind(input.runnerId, input.nonce)
    .first<{ request_hash: string; response_body: string }>();
  if (!replay || replay.request_hash !== input.requestHash) {
    throw new RunnerRepositoryError("nonce_reused", 409);
  }
  return { body: replay.response_body, replay: true };
}

async function loadEnrollmentToken(
  tokenHash: string,
): Promise<EnrollmentTokenRow | null> {
  return getD1()
    .prepare(
      `SELECT
         id, organization_id, display_name, expires_at, revoked_at,
         consumed_at, consumed_runner_id
       FROM runner_enrollment_tokens
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<EnrollmentTokenRow>();
}

function prepareEnrollmentBatch(input: {
  token: EnrollmentTokenRow;
  identity: { principalId: string; runnerId: string };
  publicKey: string;
  displayName: string;
  enrolledAt: string;
  now: string;
  entry: LedgerEntry;
}): D1PreparedStatement[] {
  const d1 = getD1();
  const guard = `EXISTS (
    SELECT 1 FROM runner_enrollment_tokens token
    WHERE token.id = ? AND token.organization_id = ?
      AND token.display_name = ?
      AND (
        token.consumed_runner_id = ?
        OR (
          token.consumed_runner_id IS NULL
          AND token.consumed_at IS NULL
          AND token.revoked_at IS NULL
          AND token.expires_at > ?
        )
      )
  )`;
  const guardBindings = [
    input.token.id,
    input.token.organization_id,
    input.displayName,
    input.identity.runnerId,
    input.now,
  ];
  return [
    d1
      .prepare(
        `INSERT INTO principals (
          id, organization_id, kind, external_id, display_name, status,
          created_at, updated_at
        )
        SELECT ?, ?, 'runner', ?, ?, 'active', ?, ?
        WHERE ${guard}
          AND NOT EXISTS (
            SELECT 1 FROM principals
            WHERE id = ? AND organization_id = ? AND kind = 'runner'
              AND external_id = ? AND display_name = ? AND status = 'active'
          )`,
      )
      .bind(
        input.identity.principalId,
        input.token.organization_id,
        input.identity.runnerId,
        input.displayName,
        input.enrolledAt,
        input.enrolledAt,
        ...guardBindings,
        input.identity.principalId,
        input.token.organization_id,
        input.identity.runnerId,
        input.displayName,
      ),
    d1
      .prepare(
        `INSERT INTO runners (
          id, organization_id, principal_id, enrollment_token_id,
          display_name, public_key, trust_profile, status,
          enrolled_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'operator_trust', 'active', ?, ?, ?
        WHERE ${guard}
          AND EXISTS (
            SELECT 1 FROM principals
            WHERE id = ? AND organization_id = ? AND kind = 'runner'
              AND external_id = ? AND display_name = ? AND status = 'active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM runners
            WHERE id = ? AND organization_id = ? AND principal_id = ?
              AND enrollment_token_id = ? AND public_key = ?
              AND status = 'active'
          )`,
      )
      .bind(
        input.identity.runnerId,
        input.token.organization_id,
        input.identity.principalId,
        input.token.id,
        input.displayName,
        input.publicKey,
        input.enrolledAt,
        input.enrolledAt,
        input.enrolledAt,
        ...guardBindings,
        input.identity.principalId,
        input.token.organization_id,
        input.identity.runnerId,
        input.displayName,
        input.identity.runnerId,
        input.token.organization_id,
        input.identity.principalId,
        input.token.id,
        input.publicKey,
      ),
    d1
      .prepare(
        `UPDATE runner_enrollment_tokens
         SET consumed_at = COALESCE(consumed_at, ?),
             consumed_runner_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND display_name = ?
           AND (
             consumed_runner_id = ?
             OR (
               consumed_runner_id IS NULL
               AND consumed_at IS NULL
               AND revoked_at IS NULL
               AND expires_at > ?
             )
           )
           AND EXISTS (
             SELECT 1 FROM runners
             WHERE id = ? AND organization_id = ?
               AND enrollment_token_id = ? AND public_key = ?
           )`,
      )
      .bind(
        input.enrolledAt,
        input.identity.runnerId,
        input.enrolledAt,
        input.token.id,
        input.token.organization_id,
        input.displayName,
        input.identity.runnerId,
        input.now,
        input.identity.runnerId,
        input.token.organization_id,
        input.token.id,
        input.publicKey,
      ),
    prepareLedgerInsert(d1, input.entry, {
      existsSql: `SELECT 1
        FROM runner_enrollment_tokens token
        INNER JOIN runners runner
          ON runner.id = token.consumed_runner_id
         AND runner.enrollment_token_id = token.id
        WHERE token.id = ? AND token.organization_id = ?
          AND token.consumed_runner_id = ?
          AND runner.public_key = ?`,
      bindings: [
        input.token.id,
        input.token.organization_id,
        input.identity.runnerId,
        input.publicKey,
      ],
      uniquePayloadKind: true,
    }),
  ];
}

async function loadEnrollmentResult(
  tokenId: string,
): Promise<EnrollmentResultRow | null> {
  return getD1()
    .prepare(
      `SELECT
         token.consumed_runner_id, token.revoked_at, token.expires_at,
         runner.public_key, runner.enrolled_at
       FROM runner_enrollment_tokens token
       LEFT JOIN runners runner ON runner.id = token.consumed_runner_id
       WHERE token.id = ?
       LIMIT 1`,
    )
    .bind(tokenId)
    .first<EnrollmentResultRow>();
}

async function executeLedgerBatch(
  organizationId: string,
  event: LedgerEvent,
  statements: (entry: LedgerEntry) => D1PreparedStatement[],
): Promise<void> {
  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const entry = await nextLedgerEntry(organizationId, event);
    try {
      await getD1().batch(statements(entry));
      return;
    } catch (error) {
      if (!isLedgerSequenceConflict(error)) throw mapRunnerDatabaseError(error);
      await ledgerRetryJitter();
    }
  }
  throw new RunnerRepositoryError("conflict_retry", 409);
}

async function nextLedgerEntry(
  organizationId: string,
  event: LedgerEvent,
): Promise<LedgerEntry> {
  const row = await getD1()
    .prepare(
      `SELECT
         id, organization_id, sequence, kind, actor_id, occurred_at,
         payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
       FROM ledger_entries
       WHERE organization_id = ?
       ORDER BY sequence DESC
       LIMIT 1`,
    )
    .bind(organizationId)
    .first<LedgerRow>();
  return appendLedgerEntry(row ? toLedgerEntry(row) : undefined, event);
}

async function loadActiveRunnerLeases(
  runnerId: string,
  organizationId: string,
): Promise<RunnerActiveLease[]> {
  const result = await getD1()
    .prepare(
      `SELECT
         lease.id, lease.run_id, lease.fence,
         COALESCE((
           SELECT MAX(event.sequence)
           FROM run_events AS event
           WHERE event.run_id = lease.run_id
         ), 0) AS event_sequence
       FROM run_leases AS lease
       WHERE lease.runner_id = ? AND lease.organization_id = ?
         AND lease.status = 'active'
       ORDER BY lease.run_id, lease.id
       LIMIT 2`,
    )
    .bind(runnerId, organizationId)
    .all<RunnerActiveLease>();
  return result.results;
}

async function loadRunnerRevocationState(
  runnerId: string,
  organizationId: string,
): Promise<RunnerRevocationState | null> {
  return getD1()
    .prepare(
      `SELECT
         runner.status,
         runner.revoked_at,
         (
           SELECT COUNT(*)
           FROM run_leases AS lease
           WHERE lease.runner_id = runner.id
             AND lease.organization_id = runner.organization_id
             AND lease.status = 'active'
         ) AS active_lease_count
       FROM runners AS runner
       WHERE runner.id = ? AND runner.organization_id = ?
       LIMIT 1`,
    )
    .bind(runnerId, organizationId)
    .first<RunnerRevocationState>();
}

function prepareRequiredRunnerLedgerInsert(
  d1: D1Database,
  entry: LedgerEntry,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      entry.id,
      entry.organizationId,
      entry.sequence,
      entry.kind,
      entry.actorId,
      entry.occurredAt,
      entry.payloadHash,
      entry.payloadRef ?? null,
      entry.previousHash,
      entry.hash,
    );
}

function prepareLedgerInsert(
  d1: D1Database,
  entry: LedgerEntry,
  guard: {
    existsSql: string;
    bindings: unknown[];
    uniquePayloadKind?: boolean;
  },
) {
  return d1
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?
      WHERE EXISTS (${guard.existsSql})
      ${
        guard.uniquePayloadKind
          ? `AND NOT EXISTS (
              SELECT 1 FROM ledger_entries
              WHERE organization_id = ? AND payload_ref = ? AND kind = ?
            )`
          : ""
      }`,
    )
    .bind(
      entry.id,
      entry.organizationId,
      entry.sequence,
      entry.kind,
      entry.actorId,
      entry.occurredAt,
      entry.payloadHash,
      entry.payloadRef ?? null,
      entry.previousHash,
      entry.hash,
      ...guard.bindings,
      ...(guard.uniquePayloadKind
        ? [entry.organizationId, entry.payloadRef ?? null, entry.kind]
        : []),
    );
}

async function cleanupRunnerNonces(
  organizationId: string,
  now: string,
): Promise<void> {
  await getD1()
    .prepare(
      `DELETE FROM runner_heartbeat_nonces
       WHERE rowid IN (
         SELECT rowid FROM runner_heartbeat_nonces
         WHERE organization_id = ? AND expires_at <= ?
         ORDER BY expires_at, runner_id, nonce
         LIMIT 100
       )`,
    )
    .bind(organizationId, now)
    .run();
}

function requiredDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new RunnerRepositoryError("invalid_runner_display_name", 400);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) {
    throw new RunnerRepositoryError("invalid_runner_display_name", 400);
  }
  return normalized;
}

function enrollmentTokenTtlMs(): number {
  if (env.NEXUS_ALLOW_TEST_IDENTITIES === "1") {
    const configured = Number(env.NEXUS_RUNNER_TEST_TOKEN_TTL_SECONDS);
    if (Number.isSafeInteger(configured) && configured >= 1 && configured <= 900) {
      return configured * 1000;
    }
  }
  return TOKEN_TTL_MS;
}

function enrollmentRejected(): RunnerRepositoryError {
  return new RunnerRepositoryError("enrollment_rejected", 403);
}

function isLedgerSequenceConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*ledger_entries\.organization_id,\s*ledger_entries\.sequence|ledger_entries_org_sequence_uidx/iu.test(
      error.message,
    )
  );
}

function isNonceConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*runner_heartbeat_nonces\.runner_id,\s*runner_heartbeat_nonces\.nonce/iu.test(
      error.message,
    )
  );
}

function isRunnerIdentityConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/UNIQUE constraint failed:\s*(?:principals|runners)\./iu.test(
      error.message,
    ) ||
      /\binvalid_runner(?:_transition|_enrollment_token_transition)?\b/iu.test(
        error.message,
      ))
  );
}

function isRunnerRevocationRace(error: unknown): boolean {
  return (
    isLedgerSequenceConflict(error) ||
    isRunEventSequenceConflict(error) ||
    (error instanceof Error &&
      /invalid_(?:run_event|run_lease_transition|runner_ledger_event)|duplicate_runner_ledger_event|UNIQUE constraint failed/iu.test(
        error.message,
      ))
  );
}

function mapRunnerDatabaseError(error: unknown): Error {
  if (error instanceof RunnerRepositoryError) return error;
  if (
    error instanceof Error &&
    /invalid_runner_heartbeat_nonce|invalid_runner_transition/iu.test(
      error.message,
    )
  ) {
    return new RunnerRepositoryError("runner_authentication_failed", 403);
  }
  return error instanceof Error ? error : new Error("Runner operation failed");
}

async function ledgerRetryJitter(): Promise<void> {
  const delayMs = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function tokenRef(tokenId: string): string {
  return `nexus://runner-enrollment-tokens/${tokenId}`;
}

function runnerRef(runnerId: string): string {
  return `nexus://runners/${runnerId}`;
}

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sequence: row.sequence,
    kind: row.kind,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    payloadHash: row.payload_hash,
    ...(row.payload_ref ? { payloadRef: row.payload_ref } : {}),
    ...(row.intent_id ? { intentId: row.intent_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    previousHash: row.previous_hash,
    hash: row.hash,
  };
}

export class RunnerRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "RunnerRepositoryError";
  }
}

type EnrollmentTokenRow = {
  id: string;
  organization_id: string;
  display_name: string;
  expires_at: string;
  revoked_at: string | null;
  consumed_at: string | null;
  consumed_runner_id: string | null;
};

type RunnerActiveLease = {
  id: string;
  run_id: string;
  fence: number;
  event_sequence: number;
};

type RunnerRevocationState = {
  status: "active" | "revoked";
  revoked_at: string | null;
  active_lease_count: number;
};

type EnrollmentResultRow = {
  consumed_runner_id: string | null;
  revoked_at: string | null;
  expires_at: string;
  public_key: string | null;
  enrolled_at: string;
};

type RunnerRow = {
  id: string;
  principal_id: string;
  display_name: string;
  public_key: string;
  trust_profile: "operator_trust";
  status: "active" | "revoked";
  enrolled_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

type LedgerRow = {
  id: string;
  organization_id: string;
  sequence: number;
  kind: LedgerEvent["kind"];
  actor_id: string;
  occurred_at: string;
  payload_hash: string;
  payload_ref: string | null;
  intent_id: string | null;
  run_id: string | null;
  previous_hash: string;
  hash: string;
};
