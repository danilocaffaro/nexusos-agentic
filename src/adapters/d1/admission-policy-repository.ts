import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import type {
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";
import type {
  RunnerAdmissionPolicy,
  RunnerAdmissionPolicyResponse,
  RunnerCapabilityName,
} from "@/src/contracts/runners";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import { hashCanonical } from "@/src/domain/governance/crypto";
import { appendLedgerEntry } from "@/src/domain/governance/ledger";
import {
  DEFAULT_RUNNER_ADMISSION_POLICY,
  nextPolicyUpdatedAt,
  parseAdmissionPolicyPut,
} from "@/src/domain/runners/admission-policy";
import {
  isWorkspaceOwnerRole,
  requireWorkspaceMember,
  requireWorkspaceOwner,
} from "./workspace-repository";

const LEDGER_RETRY_LIMIT = 5;

export async function getRunnerAdmissionPolicy(
  identity: RequestIdentity,
): Promise<RunnerAdmissionPolicyResponse> {
  const role = await requireWorkspaceMember(identity);
  return {
    policy: await loadRunnerAdmissionPolicyView(identity.organizationId),
    viewerCanEditPolicy: isWorkspaceOwnerRole(role),
  };
}

export async function putRunnerAdmissionPolicy(
  identity: RequestIdentity,
  input: Record<string, unknown>,
): Promise<RunnerAdmissionPolicyResponse> {
  await requireWorkspaceOwner(identity);
  const requested = parseAdmissionPolicyPut(input);
  if (!requested) {
    throw new AdmissionPolicyRepositoryError(
      "invalid_admission_policy",
      400,
    );
  }
  const serverNow = new Date().toISOString();
  const nextVersion = requested.expectedVersion + 1;

  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const current = await loadPolicyHead(identity.organizationId);
    if ((current?.version ?? 0) !== requested.expectedVersion) {
      throw policyVersionConflict();
    }
    const updatedAt = nextPolicyUpdatedAt(serverNow, current?.updated_at);
    if (!updatedAt) {
      throw new AdmissionPolicyRepositoryError(
        "admission_policy_failed",
        500,
      );
    }
    const event: LedgerEvent = {
      id: crypto.randomUUID(),
      organizationId: identity.organizationId,
      kind: "runner_policy.updated",
      actorId: identity.id,
      occurredAt: updatedAt,
      payloadHash: await hashCanonical({
        allowedCapabilities: requested.allowedCapabilities,
        capabilityFreshnessSeconds:
          requested.capabilityFreshnessSeconds,
        engineFreshnessSeconds: requested.engineFreshnessSeconds,
        organizationId: identity.organizationId,
        version: nextVersion,
      }),
      payloadRef: policyVersionRef(
        identity.organizationId,
        nextVersion,
      ),
    };
    const entry = await nextLedgerEntry(identity.organizationId, event);
    const d1 = getD1();
    const statements: D1PreparedStatement[] = [
      requested.expectedVersion === 0
        ? d1
            .prepare(
              `INSERT INTO runner_admission_policies (
                organization_id, version, capability_freshness_seconds,
                engine_freshness_seconds, updated_by, created_at, updated_at
              ) VALUES (?, 1, ?, ?, ?, ?, ?)`,
            )
            .bind(
              identity.organizationId,
              requested.capabilityFreshnessSeconds,
              requested.engineFreshnessSeconds,
              identity.id,
              updatedAt,
              updatedAt,
            )
        : d1
            .prepare(
              `UPDATE runner_admission_policies
               SET version = ?, capability_freshness_seconds = ?,
                   engine_freshness_seconds = ?,
                   updated_by = ?, updated_at = ?
               WHERE organization_id = ? AND version = ?`,
            )
            .bind(
              nextVersion,
              requested.capabilityFreshnessSeconds,
              requested.engineFreshnessSeconds,
              identity.id,
              updatedAt,
              identity.organizationId,
              requested.expectedVersion,
            ),
      d1
        .prepare(
          `INSERT INTO runner_admission_policy_versions (
            organization_id, version, capability_freshness_seconds,
            engine_freshness_seconds, updated_by, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          identity.organizationId,
          nextVersion,
          requested.capabilityFreshnessSeconds,
          requested.engineFreshnessSeconds,
          identity.id,
          updatedAt,
        ),
      ...requested.allowedCapabilities.map((capability) =>
        d1
          .prepare(
            `INSERT INTO runner_admission_policy_capabilities (
              organization_id, version, capability
            ) VALUES (?, ?, ?)`,
          )
          .bind(identity.organizationId, nextVersion, capability),
      ),
      preparePolicyLedgerInsert(d1, entry),
    ];

    try {
      await d1.batch(statements);
    } catch (error) {
      const after = await loadPolicyHead(identity.organizationId);
      if ((after?.version ?? 0) !== requested.expectedVersion) {
        throw policyVersionConflict();
      }
      if (isLedgerSequenceConflict(error)) {
        await retryJitter();
        continue;
      }
      throw mapPolicyDatabaseError(error);
    }

    const policy = await loadPolicyVersionView(
      identity.organizationId,
      nextVersion,
    );
    if (
      !policy ||
      policy.version !== nextVersion ||
      policy.source !== "configured" ||
      policy.capabilityFreshnessSeconds !==
        requested.capabilityFreshnessSeconds ||
      policy.engineFreshnessSeconds !==
        requested.engineFreshnessSeconds ||
      canonicalJson(policy.allowedCapabilities) !==
        canonicalJson(requested.allowedCapabilities) ||
      policy.updatedAt !== updatedAt ||
      policy.updatedBy !== identity.id
    ) {
      throw new AdmissionPolicyRepositoryError(
        "admission_policy_failed",
        500,
      );
    }
    return { policy, viewerCanEditPolicy: true };
  }
  throw policyVersionConflict();
}

export async function loadRunnerAdmissionPolicyView(
  organizationId: string,
): Promise<RunnerAdmissionPolicy> {
  const head = await loadPolicyHead(organizationId);
  if (!head) {
    return {
      ...DEFAULT_RUNNER_ADMISSION_POLICY,
      allowedCapabilities: [
        ...DEFAULT_RUNNER_ADMISSION_POLICY.allowedCapabilities,
      ],
    };
  }
  const policy = await loadPolicyVersionView(organizationId, head.version);
  if (
    !policy ||
    policy.capabilityFreshnessSeconds !==
      head.capability_freshness_seconds ||
    policy.engineFreshnessSeconds !== head.engine_freshness_seconds ||
    policy.updatedAt !== head.updated_at ||
    policy.updatedBy !== head.updated_by
  ) {
    throw new AdmissionPolicyRepositoryError(
      "admission_policy_failed",
      500,
    );
  }
  return policy;
}

async function loadPolicyVersionView(
  organizationId: string,
  version: number,
): Promise<RunnerAdmissionPolicy | null> {
  const policyVersion = await getD1()
    .prepare(
      `SELECT
         version, capability_freshness_seconds, engine_freshness_seconds,
         updated_by, recorded_at
       FROM runner_admission_policy_versions
       WHERE organization_id = ? AND version = ?
       LIMIT 1`,
    )
    .bind(organizationId, version)
    .first<PolicyVersionRow>();
  if (!policyVersion) return null;
  const result = await getD1()
    .prepare(
      `SELECT capability
       FROM runner_admission_policy_capabilities
       WHERE organization_id = ? AND version = ?
       ORDER BY CASE capability
         WHEN 'node_permission_model' THEN 1
         WHEN 'bubblewrap' THEN 2
         WHEN 'landlock' THEN 3
         WHEN 'seccomp' THEN 4
         WHEN 'user_namespace' THEN 5
         WHEN 'docker' THEN 6
         WHEN 'podman' THEN 7
         ELSE 8
       END`,
    )
    .bind(organizationId, version)
    .all<{ capability: RunnerCapabilityName }>();
  return {
    version: policyVersion.version,
    source: "configured",
    capabilityFreshnessSeconds:
      policyVersion.capability_freshness_seconds,
    engineFreshnessSeconds: policyVersion.engine_freshness_seconds,
    allowedCapabilities: result.results.map((row) => row.capability),
    updatedAt: policyVersion.recorded_at,
    updatedBy: policyVersion.updated_by,
  };
}

async function loadPolicyHead(
  organizationId: string,
): Promise<PolicyHeadRow | null> {
  return getD1()
    .prepare(
      `SELECT
         version, capability_freshness_seconds, engine_freshness_seconds,
         updated_by,
         created_at, updated_at
       FROM runner_admission_policies
       WHERE organization_id = ?
       LIMIT 1`,
    )
    .bind(organizationId)
    .first<PolicyHeadRow>();
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

function preparePolicyLedgerInsert(
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

function policyVersionRef(
  organizationId: string,
  version: number,
): string {
  return `nexus://runner-admission-policies/${organizationId}#v${version}`;
}

function isLedgerSequenceConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*ledger_entries\.organization_id,\s*ledger_entries\.sequence|ledger_entries_org_sequence_uidx/iu.test(
      error.message,
    )
  );
}

function mapPolicyDatabaseError(
  error: unknown,
): AdmissionPolicyRepositoryError {
  if (
    error instanceof Error &&
    /invalid_runner_admission_policy_actor/iu.test(error.message)
  ) {
    return new AdmissionPolicyRepositoryError(
      "workspace_owner_required",
      403,
    );
  }
  if (
    error instanceof Error &&
    /runner_admission_policies\.organization_id|runner_admission_policy_versions\.organization_id,\s*runner_admission_policy_versions\.version|invalid_runner_admission_policy_(?:transition|version)/iu.test(
      error.message,
    )
  ) {
    return policyVersionConflict();
  }
  return new AdmissionPolicyRepositoryError(
    "admission_policy_failed",
    500,
  );
}

function policyVersionConflict(): AdmissionPolicyRepositoryError {
  return new AdmissionPolicyRepositoryError(
    "policy_version_conflict",
    409,
  );
}

async function retryJitter(): Promise<void> {
  const delayMs = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class AdmissionPolicyRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "AdmissionPolicyRepositoryError";
  }
}

type PolicyHeadRow = {
  version: number;
  capability_freshness_seconds: number;
  engine_freshness_seconds: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

type PolicyVersionRow = {
  version: number;
  capability_freshness_seconds: number;
  engine_freshness_seconds: number;
  updated_by: string;
  recorded_at: string;
};

type LedgerRow = {
  id: string;
  organization_id: string;
  sequence: number;
  kind: LedgerEntry["kind"];
  actor_id: string;
  occurred_at: string;
  payload_hash: string;
  payload_ref: string | null;
  intent_id: string | null;
  run_id: string | null;
  previous_hash: string;
  hash: string;
};
