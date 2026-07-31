import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import type {
  OperationId,
  OperationPublishResult,
  OperationRead,
  OperationRegistry,
} from "@/src/contracts/operations";
import {
  contextualizeOperationPrompt,
  deriveOperationPublicationState,
  OperationOutputError,
  parseOperationCreateInput,
  projectOperationArtifactContent,
  validateOperationModel,
} from "@/src/domain/operations";
import {
  encodeExactPrompt,
  type EngineRunCreateRequest,
} from "@/src/domain/runners/engine-control-plane";
import {
  createEngineRun,
} from "@/src/adapters/d1/run-repository";
import { readEngineRunExcerpt } from "@/src/adapters/d1/engine-run-excerpt-repository";
import type { PromptCipher } from "@/src/ports/prompt-cipher";
import {
  hashCanonical,
  sha256Bytes,
} from "@/src/domain/governance/crypto";
import { validateArtifactContent } from "@/src/domain/artifacts";
import { appendLedgerEntry } from "@/src/domain/governance/ledger";
import type {
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";

const OPERATION_LIST_LIMIT = 50;

export class OperationRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "OperationRepositoryError";
  }
}

export async function createOperation(
  identity: RequestIdentity,
  operationId: OperationId,
  rawInput: Record<string, unknown>,
  prepareCipher: () => Promise<PromptCipher>,
): Promise<{ created: boolean; operation: OperationRead }> {
  await requireOperationOwner(identity);
  const input = parseOperationCreateInput(rawInput);
  const requestHash = await hashCanonical(input);
  const existing = await loadOperationRow(
    identity.organizationId,
    operationId,
  );
  if (existing) {
    assertOperationRequest(existing, requestHash, identity.id);
    return {
      created: false,
      operation: await requireOperation(identity, operationId),
    };
  }

  const snapshot = await loadOperationSnapshot(identity, input);
  const promptBytes = encodeExactPrompt(
    contextualizeOperationPrompt(snapshot, input.prompt),
  );
  const engineInput: EngineRunCreateRequest = {
    assignedRunnerId: input.assignedRunnerId,
    engine: input.engine,
    promptBytes,
    promptSha256: (await sha256Bytes(promptBytes)).hex,
  };
  // The engine is the owner's explicit execution-adapter choice; the model is
  // an immutable agent snapshot. No prefix heuristic can prove compatibility.
  // The selected CLI is authoritative and records incompatibility as a failed
  // receipt, which the operation read model blocks from publication.
  const creationId =
    `ecr_${operationId.slice(4)}` as `ecr_${string}`;

  try {
    const createdRun = await createEngineRun(
      identity,
      creationId,
      engineInput,
      prepareCipher,
      undefined,
      (d1, facts) => [
        d1
          .prepare(
            `INSERT INTO operations (
              id, organization_id, requested_by, request_hash, project_id,
              work_item_id, agent_id, assigned_runner_id, engine, run_id,
              agent_name, agent_role, agent_model, work_item_ref,
              work_item_title, work_item_description, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            operationId,
            facts.organizationId,
            facts.requestedBy,
            requestHash,
            input.projectId,
            input.workItemId,
            input.agentId,
            input.assignedRunnerId,
            input.engine,
            facts.runId,
            snapshot.agentName,
            snapshot.agentRole,
            snapshot.agentModel,
            snapshot.workItemRef,
            snapshot.workItemTitle,
            snapshot.workItemDescription,
            facts.createdAt,
          ),
      ],
    );
    if (
      createdRun.resolution.state !== "created" ||
      createdRun.replay
    ) {
      throw new OperationRepositoryError(
        "operation_binding_conflict",
        409,
      );
    }
  } catch (error) {
    const raced = await loadOperationRow(
      identity.organizationId,
      operationId,
    );
    if (raced) {
      assertOperationRequest(raced, requestHash, identity.id);
      return {
        created: false,
        operation: await requireOperation(identity, operationId),
      };
    }
    throw error;
  } finally {
    promptBytes.fill(0);
  }

  return {
    created: true,
    operation: await requireOperation(identity, operationId),
  };
}

export async function listOperations(
  identity: RequestIdentity,
): Promise<OperationRegistry> {
  await requireOperationOwner(identity);
  const result = await getD1()
    .prepare(
      `${OPERATION_READ_QUERY}
       WHERE operation.organization_id = ?
       ORDER BY operation.created_at DESC, operation.id DESC
       LIMIT ?`,
    )
    .bind(identity.organizationId, OPERATION_LIST_LIMIT)
    .all<OperationReadRow>();
  return {
    operations: await Promise.all(
      result.results.map((row) => resolveOperationRead(identity, row)),
    ),
  };
}

export async function requireOperation(
  identity: RequestIdentity,
  operationId: string,
): Promise<OperationRead> {
  await requireOperationOwner(identity);
  const row = await getD1()
    .prepare(
      `${OPERATION_READ_QUERY}
       WHERE operation.id = ? AND operation.organization_id = ?
       LIMIT 1`,
    )
    .bind(operationId, identity.organizationId)
    .first<OperationReadRow>();
  if (!row) {
    throw new OperationRepositoryError("operation_not_found", 404);
  }
  return resolveOperationRead(identity, row);
}

export async function publishOperation(
  identity: RequestIdentity,
  operationId: string,
): Promise<OperationPublishResult> {
  await requireOperationOwner(identity);
  const existing = await requireOperation(identity, operationId);
  if (existing.publication.state === "published") {
    return { published: false, operation: existing };
  }
  if (existing.publication.state === "blocked") {
    throw new OperationRepositoryError(
      existing.publication.reason,
      409,
    );
  }
  if (existing.publication.state !== "eligible") {
    throw new OperationRepositoryError(
      "operation_not_publishable",
      409,
    );
  }

  const excerpt = await readEngineRunExcerpt(identity, existing.runId);
  if (
    excerpt.state !== "stored" ||
    excerpt.receipt.stdout.bytes < 1
  ) {
    throw new OperationRepositoryError(
      "operation_not_publishable",
      409,
    );
  }
  const stdoutBytes = decodeCanonicalBase64Url(excerpt.stdoutBase64Url);
  if (
    !stdoutBytes ||
    stdoutBytes.byteLength !== excerpt.receipt.stdout.excerptBytes
  ) {
    throw new OperationRepositoryError(
      "operation_output_integrity_failed",
      503,
    );
  }
  let projectedOutput: string;
  try {
    projectedOutput = projectOperationArtifactContent(
      existing.engine,
      stdoutBytes,
      excerpt.receipt.stdout.truncated,
    );
  } catch (error) {
    if (error instanceof OperationOutputError) {
      throw new OperationRepositoryError(error.code, 409);
    }
    throw new OperationRepositoryError(
      "output_unavailable",
      409,
    );
  } finally {
    stdoutBytes.fill(0);
  }
  const content = await validateArtifactContent(projectedOutput);
  const artifactTitle = `Operation ${existing.workItem.ref}`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raced = await requireOperation(identity, operationId);
    if (raced.publication.state === "published") {
      return { published: false, operation: raced };
    }
    if (raced.publication.state === "blocked") {
      throw new OperationRepositoryError(
        raced.publication.reason,
        409,
      );
    }
    const now = new Date().toISOString();
    const artifactId = crypto.randomUUID();
    const artifactVersionId = crypto.randomUUID();
    const payloadId = crypto.randomUUID();
    const ledger = await nextOperationLedgerEntry(
      identity.organizationId,
      {
        id: crypto.randomUUID(),
        organizationId: identity.organizationId,
        kind: "artifact.registered",
        actorId: identity.id,
        occurredAt: now,
        payloadHash: await hashCanonical({
          artifactId,
          artifactVersionId,
          contentHash: content.contentHash,
          operationId,
          runId: existing.runId,
        }),
        payloadRef: artifactId,
        runId: existing.runId,
      },
    );
    try {
      const d1 = getD1();
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO artifact_payloads (
              id, organization_id, content_hash, byte_size, body_text
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            payloadId,
            identity.organizationId,
            content.contentHash,
            content.byteSize,
            content.content,
          ),
        d1
          .prepare(
            `INSERT INTO artifacts (
              id, organization_id, project_id, work_item_id, title,
              media_type, current_version, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'text/markdown', 0, ?, ?, ?)`,
          )
          .bind(
            artifactId,
            identity.organizationId,
            existing.projectId,
            existing.workItem.id,
            artifactTitle,
            identity.id,
            now,
            now,
          ),
        d1
          .prepare(
            `INSERT INTO artifact_versions (
              id, organization_id, artifact_id, version_number, content_ref,
              content_hash, byte_size, note, created_by, created_at
            ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            artifactVersionId,
            identity.organizationId,
            artifactId,
            payloadId,
            content.contentHash,
            content.byteSize,
            `Published from NexusOS operation ${operationId}.`,
            identity.id,
            now,
          ),
        d1
          .prepare(
            `UPDATE artifacts SET current_version = 1, updated_at = ?
             WHERE id = ? AND organization_id = ? AND current_version = 0`,
          )
          .bind(now, artifactId, identity.organizationId),
        d1
          .prepare(
            `INSERT INTO operation_publications (
              operation_id, organization_id, artifact_id,
              artifact_version_id, content_hash, stdout_truncated,
              published_by, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            operationId,
            identity.organizationId,
            artifactId,
            artifactVersionId,
            content.contentHash,
            excerpt.receipt.stdout.truncated ? 1 : 0,
            identity.id,
            now,
          ),
        prepareOperationLedgerInsert(d1, ledger),
      ]);
      return {
        published: true,
        operation: await requireOperation(identity, operationId),
      };
    } catch (error) {
      const afterConflict = await requireOperation(identity, operationId);
      if (afterConflict.publication.state === "published") {
        return { published: false, operation: afterConflict };
      }
      if (afterConflict.publication.state === "blocked") {
        throw new OperationRepositoryError(
          afterConflict.publication.reason,
          409,
        );
      }
      if (attempt === 4) throw error;
    }
  }
  throw new OperationRepositoryError("operation_publication_failed", 503);
}

async function requireOperationOwner(
  identity: RequestIdentity,
): Promise<void> {
  const owner = await getD1()
    .prepare(
      `SELECT 1
       FROM memberships membership
       INNER JOIN principals principal
         ON principal.id = membership.principal_id
        AND principal.organization_id = membership.organization_id
       WHERE membership.organization_id = ?
         AND membership.principal_id = ?
         AND membership.role = 'owner'
         AND membership.status = 'active'
         AND principal.kind = 'human'
         AND principal.status = 'active'
       LIMIT 1`,
    )
    .bind(identity.organizationId, identity.id)
    .first();
  if (!owner) {
    throw new OperationRepositoryError("workspace_owner_required", 403);
  }
}

async function loadOperationSnapshot(
  identity: RequestIdentity,
  input: ReturnType<typeof parseOperationCreateInput>,
) {
  const row = await getD1()
    .prepare(
      `SELECT
         work_item.ref AS work_item_ref,
         work_item.title AS work_item_title,
         work_item.description AS work_item_description,
         agent.name AS agent_name,
         agent.role AS agent_role,
         agent.model AS agent_model
       FROM projects project
       INNER JOIN work_items work_item
         ON work_item.project_id = project.id
        AND work_item.organization_id = project.organization_id
       INNER JOIN agent_definitions agent
         ON agent.organization_id = project.organization_id
       INNER JOIN principals agent_principal
         ON agent_principal.id = agent.principal_id
        AND agent_principal.organization_id = agent.organization_id
       INNER JOIN team_members assignment
         ON assignment.principal_id = agent.principal_id
        AND assignment.organization_id = agent.organization_id
       INNER JOIN teams team
         ON team.id = assignment.team_id
        AND team.organization_id = assignment.organization_id
        AND team.project_id = project.id
       INNER JOIN runners runner
         ON runner.id = ?
        AND runner.organization_id = project.organization_id
       INNER JOIN principals runner_principal
         ON runner_principal.id = runner.principal_id
        AND runner_principal.organization_id = runner.organization_id
       WHERE project.id = ? AND project.organization_id = ?
         AND project.status = 'active'
         AND work_item.id = ?
         AND work_item.status NOT IN ('done', 'cancelled')
         AND agent.id = ? AND agent.status = 'active'
         AND agent_principal.kind = 'agent'
         AND agent_principal.status = 'active'
         AND assignment.status = 'active'
         AND team.status = 'active'
         AND runner.status = 'active'
         AND runner_principal.kind = 'runner'
         AND runner_principal.status = 'active'
       ORDER BY team.id
       LIMIT 1`,
    )
    .bind(
      input.assignedRunnerId,
      input.projectId,
      identity.organizationId,
      input.workItemId,
      input.agentId,
    )
    .first<OperationSnapshotRow>();
  if (!row) {
    throw new OperationRepositoryError(
      "invalid_operation_reference",
      422,
    );
  }
  return {
    agentName: row.agent_name,
    agentRole: row.agent_role,
    agentModel: validateOperationModel(row.agent_model),
    workItemRef: row.work_item_ref,
    workItemTitle: row.work_item_title,
    workItemDescription: row.work_item_description,
  };
}

async function loadOperationRow(
  organizationId: string,
  operationId: string,
): Promise<OperationIdentityRow | null> {
  return getD1()
    .prepare(
      `SELECT requested_by, request_hash
       FROM operations
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(operationId, organizationId)
    .first<OperationIdentityRow>();
}

function assertOperationRequest(
  row: OperationIdentityRow,
  requestHash: string,
  requestedBy: string,
): void {
  if (
    row.request_hash !== requestHash ||
    row.requested_by !== requestedBy
  ) {
    throw new OperationRepositoryError("idempotency_key_reused", 409);
  }
}

function toOperationRead(row: OperationReadRow): OperationRead {
  const receipt = row.receipt_status
    ? {
        status: row.receipt_status,
        reason: row.receipt_reason!,
        stdout: {
          bytes: row.stdout_bytes!,
          sha256: row.stdout_sha256!,
          truncated: row.stdout_truncated === 1,
          excerptBytes: row.stdout_excerpt_bytes!,
        },
        receiptSha256: row.receipt_sha256!,
        recordedAt: row.recorded_at!,
      }
    : undefined;
  const publication = row.artifact_id
    ? {
        state: "published" as const,
        artifactId: row.artifact_id,
        versionNumber: 1 as const,
        contentHash: row.publication_content_hash!,
        publishedAt: row.published_at!,
        stdoutTruncated: row.publication_stdout_truncated === 1,
      }
    : operationPublicationState(row);
  return {
    id: row.id as OperationId,
    projectId: row.project_id,
    workItem: {
      id: row.work_item_id,
      ref: row.work_item_ref,
      title: row.work_item_title,
    },
    agent: {
      id: row.agent_id,
      name: row.agent_name,
      role: row.agent_role,
      model: row.agent_model,
    },
    assignedRunnerId: row.assigned_runner_id,
    engine: row.engine,
    runId: row.run_id,
    run: {
      status: row.run_status,
      ...(row.outcome_status
        ? { outcomeStatus: row.outcome_status }
        : {}),
      deadlineAt: row.deadline_at,
      createdAt: row.run_created_at,
    },
    ...(receipt ? { receipt } : {}),
    publication,
    createdAt: row.created_at,
  };
}

function operationPublicationState(
  row: OperationReadRow,
): OperationRead["publication"] {
  return deriveOperationPublicationState({
    runStatus: row.run_status,
    outcomeStatus: row.outcome_status,
    receiptStatus: row.receipt_status,
    receiptReason: row.receipt_reason,
    stdoutBytes: row.stdout_bytes,
    stdoutTruncated: row.stdout_truncated === 1,
    excerptAvailable: row.excerpt_erased_at === null,
  });
}

async function resolveOperationRead(
  identity: RequestIdentity,
  row: OperationReadRow,
): Promise<OperationRead> {
  const operation = toOperationRead(row);
  if (operation.publication.state !== "eligible") return operation;
  try {
    const excerpt = await readEngineRunExcerpt(identity, operation.runId);
    if (excerpt.state !== "stored") {
      return blockedOperation(operation, "output_unavailable");
    }
    const bytes = decodeCanonicalBase64Url(excerpt.stdoutBase64Url);
    if (
      !bytes ||
      bytes.byteLength !== excerpt.receipt.stdout.excerptBytes
    ) {
      bytes?.fill(0);
      return blockedOperation(operation, "output_unavailable");
    }
    try {
      projectOperationArtifactContent(
        operation.engine,
        bytes,
        excerpt.receipt.stdout.truncated,
      );
      return operation;
    } catch (error) {
      return blockedOperation(
        operation,
        error instanceof OperationOutputError &&
          error.code === "output_empty"
          ? "output_empty"
          : "output_unavailable",
      );
    } finally {
      bytes.fill(0);
    }
  } catch {
    return blockedOperation(operation, "output_unavailable");
  }
}

function blockedOperation(
  operation: OperationRead,
  reason: "output_empty" | "output_unavailable",
): OperationRead {
  return { ...operation, publication: { state: "blocked", reason } };
}

const OPERATION_READ_QUERY = `SELECT
  operation.id, operation.project_id, operation.work_item_id,
  operation.agent_id, operation.assigned_runner_id, operation.engine,
  operation.run_id, operation.agent_name, operation.agent_role,
  operation.agent_model, operation.work_item_ref,
  operation.work_item_title, operation.created_at,
  run.status AS run_status, run.outcome_status, run.deadline_at,
  run.created_at AS run_created_at,
  receipt.status AS receipt_status, receipt.reason AS receipt_reason,
  receipt.stdout_bytes, receipt.stdout_sha256, receipt.stdout_truncated,
  receipt.stdout_excerpt_bytes, receipt.receipt_sha256,
  receipt.recorded_at, excerpt.erased_at AS excerpt_erased_at,
  publication.artifact_id,
  publication.content_hash AS publication_content_hash,
  publication.stdout_truncated AS publication_stdout_truncated,
  publication.published_at
FROM operations operation
INNER JOIN runs run
  ON run.id = operation.run_id
 AND run.organization_id = operation.organization_id
LEFT JOIN run_engine_receipts receipt
  ON receipt.run_id = run.id
 AND receipt.organization_id = run.organization_id
LEFT JOIN run_engine_excerpts excerpt
  ON excerpt.run_id = receipt.run_id
 AND excerpt.organization_id = receipt.organization_id
 AND excerpt.excerpt_ref = receipt.excerpt_ref
LEFT JOIN operation_publications publication
  ON publication.operation_id = operation.id
 AND publication.organization_id = operation.organization_id`;

type OperationSnapshotRow = {
  agent_name: string;
  agent_role: string;
  agent_model: string;
  work_item_ref: string;
  work_item_title: string;
  work_item_description: string;
};

type OperationIdentityRow = {
  requested_by: string;
  request_hash: string;
};

type OperationReadRow = {
  id: string;
  project_id: string;
  work_item_id: string;
  agent_id: string;
  assigned_runner_id: string;
  engine: "claude_code_cli" | "codex_cli";
  run_id: string;
  agent_name: string;
  agent_role: string;
  agent_model: string;
  work_item_ref: string;
  work_item_title: string;
  created_at: string;
  run_status: "queued" | "leased" | "completed" | "canceled" | "expired";
  outcome_status: "succeeded" | "failed" | "canceled" | null;
  deadline_at: string;
  run_created_at: string;
  receipt_status: "succeeded" | "failed" | "canceled" | null;
  receipt_reason:
    | "none"
    | "engine_incompatible"
    | "prompt_unavailable"
    | "prompt_erased"
    | "prompt_integrity_mismatch"
    | "spawn_failed"
    | "timed_out"
    | "cancel_requested"
    | "lease_lost"
    | "output_limit_reached"
    | "interrupted_after_start"
    | "orphan_identity_ambiguous"
    | "engine_exit_nonzero"
    | "protocol_invalid"
    | null;
  stdout_bytes: number | null;
  stdout_sha256: string | null;
  stdout_truncated: number | null;
  stdout_excerpt_bytes: number | null;
  receipt_sha256: string | null;
  recorded_at: string | null;
  excerpt_erased_at: string | null;
  artifact_id: string | null;
  publication_content_hash: string | null;
  publication_stdout_truncated: number | null;
  published_at: string | null;
};

async function nextOperationLedgerEntry(
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
    .first<OperationLedgerRow>();
  return appendLedgerEntry(row ? toOperationLedgerEntry(row) : undefined, event);
}

function prepareOperationLedgerInsert(
  d1: D1Database,
  entry: LedgerEntry,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
      entry.runId ?? null,
      entry.previousHash,
      entry.hash,
    );
}

function toOperationLedgerEntry(row: OperationLedgerRow): LedgerEntry {
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

function decodeCanonicalBase64Url(value: string): Uint8Array | undefined {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/u.test(value)
  ) {
    return undefined;
  }
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(
      standard + "=".repeat((4 - (standard.length % 4)) % 4),
    );
    const bytes = Uint8Array.from(decoded, (character) =>
      character.charCodeAt(0),
    );
    const canonical = btoa(
      String.fromCharCode(...bytes),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    return canonical === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

type OperationLedgerRow = {
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
