import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [uniqueIndex("organizations_slug_uidx").on(table.slug)],
);

export const principals = sqliteTable(
  "principals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    kind: text("kind", {
      enum: ["human", "agent", "automation", "policy", "runner"],
    }).notNull(),
    externalId: text("external_id"),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["active", "disabled", "archived"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [
    index("principals_org_idx").on(table.organizationId),
    uniqueIndex("principals_org_external_uidx").on(
      table.organizationId,
      table.externalId,
    ),
  ],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    status: text("status", { enum: ["active", "invited", "suspended"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("memberships_org_principal_uidx").on(
      table.organizationId,
      table.principalId,
    ),
  ],
);

export const runnerEnrollmentTokens = sqliteTable(
  "runner_enrollment_tokens",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    tokenHash: text("token_hash").notNull(),
    issuedBy: text("issued_by")
      .notNull()
      .references(() => principals.id),
    displayName: text("display_name").notNull(),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by").references(() => principals.id),
    consumedAt: text("consumed_at"),
    consumedRunnerId: text("consumed_runner_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("runner_enrollment_tokens_hash_uidx").on(table.tokenHash),
    index("runner_enrollment_tokens_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const runners = sqliteTable(
  "runners",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    enrollmentTokenId: text("enrollment_token_id")
      .notNull()
      .references(() => runnerEnrollmentTokens.id),
    displayName: text("display_name").notNull(),
    publicKey: text("public_key").notNull(),
    trustProfile: text("trust_profile", { enum: ["operator_trust"] })
      .notNull()
      .default("operator_trust"),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    enrolledAt: text("enrolled_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by").references(() => principals.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("runners_principal_uidx").on(table.principalId),
    uniqueIndex("runners_enrollment_token_uidx").on(
      table.enrollmentTokenId,
    ),
    uniqueIndex("runners_org_public_key_uidx").on(
      table.organizationId,
      table.publicKey,
    ),
    uniqueIndex("runners_org_id_uidx").on(
      table.organizationId,
      table.id,
    ),
    index("runners_org_status_last_seen_idx").on(
      table.organizationId,
      table.status,
      table.lastSeenAt,
    ),
  ],
);

export const runnerHeartbeatNonces = sqliteTable(
  "runner_heartbeat_nonces",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id),
    nonce: text("nonce").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body").notNull(),
    occurredAt: text("occurred_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runnerId, table.nonce] }),
    index("runner_heartbeat_nonces_expires_idx").on(table.expiresAt),
  ],
);

export const runnerCapabilityReports = sqliteTable(
  "runner_capability_reports",
  {
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    reportId: text("report_id").notNull(),
    requestHash: text("request_hash").notNull(),
    declarationHash: text("declaration_hash").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    platformOs: text("platform_os").notNull(),
    platformArch: text("platform_arch").notNull(),
    nodeVersion: text("node_version").notNull(),
    collectedAt: text("collected_at").notNull(),
    receivedAt: text("received_at").notNull(),
    truncated: integer("truncated", { mode: "boolean" }).notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body"),
    replayCount: integer("replay_count").notNull().default(0),
    compactedAt: text("compacted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.runnerId, table.reportId] }),
    foreignKey({
      columns: [table.organizationId, table.runnerId],
      foreignColumns: [runners.organizationId, runners.id],
      name: "runner_capability_reports_org_runner_fk",
    }).onDelete("restrict"),
    index("runner_capability_reports_org_runner_history_idx").on(
      table.organizationId,
      table.runnerId,
      table.receivedAt,
      table.reportId,
    ),
    index("runner_capability_reports_compaction_idx").on(
      table.organizationId,
      table.compactedAt,
      table.receivedAt,
    ),
    check(
      "runner_capability_reports_schema_check",
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      "runner_capability_reports_truncated_check",
      sql`${table.truncated} IN (0, 1)`,
    ),
    check(
      "runner_capability_reports_response_check",
      sql`${table.responseStatus} BETWEEN 100 AND 599
        AND (${table.responseBody} IS NULL OR length(CAST(${table.responseBody} AS BLOB)) <= 65536)`,
    ),
    check(
      "runner_capability_reports_replay_check",
      sql`${table.replayCount} >= 0`,
    ),
  ],
);

export const runnerCapabilityEvidence = sqliteTable(
  "runner_capability_evidence",
  {
    runnerId: text("runner_id").notNull(),
    reportId: text("report_id").notNull(),
    position: integer("position").notNull(),
    capability: text("capability", {
      enum: [
        "node_permission_model",
        "bubblewrap",
        "landlock",
        "seccomp",
        "user_namespace",
        "docker",
        "podman",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["available", "unavailable", "unknown"],
    }).notNull(),
    detection: text("detection", {
      enum: ["node_flag", "binary_version", "proc_read", "syscall", "none"],
    }).notNull(),
    reasonCode: text("reason_code", {
      enum: [
        "none",
        "not_found",
        "not_supported",
        "permission_denied",
        "probe_disabled",
        "unknown",
      ],
    }).notNull(),
    version: text("version"),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.reportId, table.position],
    }),
    foreignKey({
      columns: [table.runnerId, table.reportId],
      foreignColumns: [
        runnerCapabilityReports.runnerId,
        runnerCapabilityReports.reportId,
      ],
      name: "runner_capability_evidence_report_fk",
    }).onDelete("restrict"),
    uniqueIndex("runner_capability_evidence_capability_uidx").on(
      table.runnerId,
      table.reportId,
      table.capability,
    ),
    check(
      "runner_capability_evidence_position_check",
      sql`${table.position} >= 0 AND ${table.position} < 16`,
    ),
    check(
      "runner_capability_evidence_capability_check",
      sql`${table.capability} IN (
        'node_permission_model', 'bubblewrap', 'landlock', 'seccomp',
        'user_namespace', 'docker', 'podman'
      )`,
    ),
    check(
      "runner_capability_evidence_status_check",
      sql`${table.status} IN ('available', 'unavailable', 'unknown')`,
    ),
    check(
      "runner_capability_evidence_detection_check",
      sql`${table.detection} IN ('node_flag', 'binary_version', 'proc_read', 'syscall', 'none')`,
    ),
    check(
      "runner_capability_evidence_reason_check",
      sql`${table.reasonCode} IN (
        'none', 'not_found', 'not_supported', 'permission_denied',
        'probe_disabled', 'unknown'
      )`,
    ),
    check(
      "runner_capability_evidence_version_check",
      sql`${table.version} IS NULL OR (
        length(CAST(${table.version} AS BLOB)) BETWEEN 1 AND 64
        AND ${table.version} NOT GLOB '*[^0-9A-Za-z._+-]*'
        AND substr(${table.version}, 1, 1) GLOB '[0-9A-Za-z]'
      )`,
    ),
  ],
);

export const runnerEngineReports = sqliteTable(
  "runner_engine_reports",
  {
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    reportId: text("report_id").notNull(),
    requestHash: text("request_hash").notNull(),
    declarationHash: text("declaration_hash").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    collectedAt: text("collected_at").notNull(),
    receivedAt: text("received_at").notNull(),
    truncated: integer("truncated", { mode: "boolean" }).notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body"),
    replayCount: integer("replay_count").notNull().default(0),
    compactedAt: text("compacted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.runnerId, table.reportId] }),
    foreignKey({
      columns: [table.organizationId, table.runnerId],
      foreignColumns: [runners.organizationId, runners.id],
      name: "runner_engine_reports_org_runner_fk",
    }).onDelete("restrict"),
    index("runner_engine_reports_org_runner_history_idx").on(
      table.organizationId,
      table.runnerId,
      table.receivedAt,
      table.reportId,
    ),
    index("runner_engine_reports_compaction_idx").on(
      table.organizationId,
      table.compactedAt,
      table.receivedAt,
    ),
    check(
      "runner_engine_reports_schema_check",
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      "runner_engine_reports_truncated_check",
      sql`${table.truncated} IN (0, 1)`,
    ),
    check(
      "runner_engine_reports_response_check",
      sql`${table.responseStatus} BETWEEN 100 AND 599
        AND (${table.responseBody} IS NULL OR length(CAST(${table.responseBody} AS BLOB)) <= 65536)`,
    ),
    check(
      "runner_engine_reports_replay_check",
      sql`${table.replayCount} >= 0`,
    ),
  ],
);

export const runnerEngineEvidence = sqliteTable(
  "runner_engine_evidence",
  {
    runnerId: text("runner_id").notNull(),
    reportId: text("report_id").notNull(),
    position: integer("position").notNull(),
    engine: text("engine", {
      enum: ["claude_code_cli", "codex_cli"],
    }).notNull(),
    status: text("status", {
      enum: ["available", "unavailable", "unknown"],
    }).notNull(),
    readiness: text("readiness", {
      enum: ["ready", "attention_required", "unknown"],
    }).notNull(),
    reason: text("reason", {
      enum: [
        "none",
        "engine_not_configured",
        "engine_binary_invalid",
        "engine_auth_attention_required",
        "engine_incompatible",
        "engine_probe_failed",
      ],
    }).notNull(),
    version: text("version"),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.reportId, table.position],
    }),
    foreignKey({
      columns: [table.runnerId, table.reportId],
      foreignColumns: [
        runnerEngineReports.runnerId,
        runnerEngineReports.reportId,
      ],
      name: "runner_engine_evidence_report_fk",
    }).onDelete("restrict"),
    uniqueIndex("runner_engine_evidence_engine_uidx").on(
      table.runnerId,
      table.reportId,
      table.engine,
    ),
    check(
      "runner_engine_evidence_position_check",
      sql`${table.position} BETWEEN 0 AND 1`,
    ),
    check(
      "runner_engine_evidence_engine_check",
      sql`${table.engine} IN ('claude_code_cli', 'codex_cli')`,
    ),
    check(
      "runner_engine_evidence_status_check",
      sql`${table.status} IN ('available', 'unavailable', 'unknown')`,
    ),
    check(
      "runner_engine_evidence_readiness_check",
      sql`${table.readiness} IN ('ready', 'attention_required', 'unknown')`,
    ),
    check(
      "runner_engine_evidence_reason_check",
      sql`${table.reason} IN (
        'none', 'engine_not_configured', 'engine_binary_invalid',
        'engine_auth_attention_required', 'engine_incompatible',
        'engine_probe_failed'
      )`,
    ),
    check(
      "runner_engine_evidence_version_check",
      sql`${table.version} IS NULL OR (
        length(CAST(${table.version} AS BLOB)) BETWEEN 1 AND 64
        AND ${table.version} NOT GLOB '*[^0-9A-Za-z ._+()-]*'
        AND substr(${table.version}, 1, 1) GLOB '[0-9A-Za-z]'
      )`,
    ),
  ],
);

export const runnerCapabilityNonces = sqliteTable(
  "runner_capability_nonces",
  {
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    nonce: text("nonce").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body").notNull(),
    occurredAt: text("occurred_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runnerId, table.nonce] }),
    foreignKey({
      columns: [table.organizationId, table.runnerId],
      foreignColumns: [runners.organizationId, runners.id],
      name: "runner_capability_nonces_org_runner_fk",
    }).onDelete("restrict"),
    index("runner_capability_nonces_expiry_idx").on(
      table.organizationId,
      table.expiresAt,
      table.runnerId,
      table.nonce,
    ),
    check(
      "runner_capability_nonces_response_check",
      sql`${table.responseStatus} BETWEEN 100 AND 599
        AND length(CAST(${table.responseBody} AS BLOB)) <= 65536`,
    ),
  ],
);

export const runnerAdmissionPolicies = sqliteTable(
  "runner_admission_policies",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    version: integer("version").notNull(),
    capabilityFreshnessSeconds: integer(
      "capability_freshness_seconds",
    ).notNull(),
    // Migration 0024 adds the range CHECK inline with this forward-only
    // column. Declaring it as a table CHECK here would make Drizzle propose a
    // destructive SQLite table rebuild; the migration suite asserts the live
    // sqlite_master constraint so a later rebuild cannot silently drop it.
    engineFreshnessSeconds: integer("engine_freshness_seconds")
      .notNull()
      .default(86_400),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => principals.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "runner_admission_policies_version_check",
      sql`${table.version} >= 1`,
    ),
    check(
      "runner_admission_policies_freshness_check",
      sql`${table.capabilityFreshnessSeconds} BETWEEN 3600 AND 2592000`,
    ),
  ],
);

export const runnerAdmissionPolicyVersions = sqliteTable(
  "runner_admission_policy_versions",
  {
    organizationId: text("organization_id").notNull(),
    version: integer("version").notNull(),
    capabilityFreshnessSeconds: integer(
      "capability_freshness_seconds",
    ).notNull(),
    // See the current-policy column above. Immutable historical rows receive
    // only the additive 86400 default and retain the inline migration CHECK.
    engineFreshnessSeconds: integer("engine_freshness_seconds")
      .notNull()
      .default(86_400),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => principals.id),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.version] }),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [runnerAdmissionPolicies.organizationId],
      name: "runner_admission_policy_versions_policy_fk",
    }).onDelete("restrict"),
    check(
      "runner_admission_policy_versions_version_check",
      sql`${table.version} >= 1`,
    ),
    check(
      "runner_admission_policy_versions_freshness_check",
      sql`${table.capabilityFreshnessSeconds} BETWEEN 3600 AND 2592000`,
    ),
  ],
);

export const runnerAdmissionPolicyCapabilities = sqliteTable(
  "runner_admission_policy_capabilities",
  {
    organizationId: text("organization_id").notNull(),
    version: integer("version").notNull(),
    capability: text("capability", {
      enum: [
        "node_permission_model",
        "bubblewrap",
        "landlock",
        "seccomp",
        "user_namespace",
        "docker",
        "podman",
      ],
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.version, table.capability],
    }),
    foreignKey({
      columns: [table.organizationId, table.version],
      foreignColumns: [
        runnerAdmissionPolicyVersions.organizationId,
        runnerAdmissionPolicyVersions.version,
      ],
      name: "runner_admission_policy_capabilities_version_fk",
    }).onDelete("restrict"),
    check(
      "runner_admission_policy_capabilities_name_check",
      sql`${table.capability} IN (
        'node_permission_model', 'bubblewrap', 'landlock', 'seccomp',
        'user_namespace', 'docker', 'podman'
      )`,
    ),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => principals.id),
    kind: text("kind", { enum: ["diagnostic", "engine_prompt"] })
      .notNull()
      .default("diagnostic"),
    status: text("status", {
      enum: ["queued", "leased", "completed", "canceled", "expired"],
    })
      .notNull()
      .default("queued"),
    version: integer("version").notNull().default(1),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    currentLeaseId: text("current_lease_id"),
    claimCount: integer("claim_count").notNull().default(0),
    maxClaims: integer("max_claims").notNull().default(5),
    deadlineAt: text("deadline_at").notNull(),
    engine: text("engine", {
      enum: ["claude_code_cli", "codex_cli"],
    }),
    assignedRunnerId: text("assigned_runner_id").references(() => runners.id),
    requiredCapability: text("required_capability", {
      enum: [
        "node_permission_model",
        "bubblewrap",
        "landlock",
        "seccomp",
        "user_namespace",
        "docker",
        "podman",
      ],
    }),
    cancelRequestedAt: text("cancel_requested_at"),
    cancelRequestedBy: text("cancel_requested_by").references(
      () => principals.id,
    ),
    outcomeStatus: text("outcome_status", {
      enum: ["succeeded", "failed", "canceled"],
    }),
    outcomeSummary: text("outcome_summary"),
    completedOperationId: text("completed_operation_id"),
    recordedAt: text("recorded_at"),
    ...timestamps,
  },
  (table) => [
    index("runs_org_status_created_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index("runs_org_requested_created_idx").on(
      table.organizationId,
      table.requestedBy,
      table.createdAt,
    ),
    index("runs_engine_deadline_due_idx").on(
      table.kind,
      table.status,
      table.deadlineAt,
      table.id,
    ),
    index("runs_engine_retention_due_idx").on(
      table.kind,
      table.status,
      table.recordedAt,
      table.id,
    ),
  ],
);

export const runPrompts = sqliteTable(
  "run_prompts",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "restrict" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    promptRef: text("prompt_ref").notNull(),
    cipherVersion: integer("cipher_version").notNull(),
    keyId: text("key_id"),
    iv: blob("iv", { mode: "buffer" }),
    ciphertext: blob("ciphertext", { mode: "buffer" }),
    tag: blob("tag", { mode: "buffer" }),
    promptSha256: text("prompt_sha256").notNull(),
    promptBytes: integer("prompt_bytes").notNull(),
    createdAt: text("created_at").notNull(),
    erasedAt: text("erased_at"),
  },
  (table) => [
    uniqueIndex("run_prompts_org_ref_uidx").on(
      table.organizationId,
      table.promptRef,
    ),
    index("run_prompts_live_key_idx")
      .on(table.keyId, table.runId)
      .where(sql`${table.erasedAt} IS NULL`),
    index("run_prompts_retention_due_idx").on(
      table.erasedAt,
      table.createdAt,
      table.runId,
    ),
    check(
      "run_prompts_cipher_version_check",
      sql`${table.cipherVersion} = 1`,
    ),
    check(
      "run_prompts_bytes_check",
      sql`${table.promptBytes} BETWEEN 1 AND 8192`,
    ),
    check(
      "run_prompts_sha256_check",
      sql`length(${table.promptSha256}) = 64
        AND ${table.promptSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "run_prompts_crypto_state_check",
      sql`(
        ${table.erasedAt} IS NULL
        AND ${table.keyId} IS NOT NULL
        AND ${table.iv} IS NOT NULL
        AND ${table.ciphertext} IS NOT NULL
        AND ${table.tag} IS NOT NULL
      ) OR (
        ${table.erasedAt} IS NOT NULL
        AND ${table.keyId} IS NULL
        AND ${table.iv} IS NULL
        AND ${table.ciphertext} IS NULL
        AND ${table.tag} IS NULL
      )`,
    ),
  ],
);

export const runLeases = sqliteTable(
  "run_leases",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id),
    fence: integer("fence").notNull(),
    status: text("status", {
      enum: ["active", "superseded", "released", "revoked"],
    })
      .notNull()
      .default("active"),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    renewedAt: text("renewed_at"),
    renewCount: integer("renew_count").notNull().default(0),
    endedAt: text("ended_at"),
    endedReason: text("ended_reason"),
    admissionBasis: text("admission_basis", {
      enum: [
        "assignment_only",
        "capability_declaration",
        "engine_inventory",
      ],
    }),
    admissionPolicySource: text("admission_policy_source", {
      enum: ["default", "configured"],
    }),
    admissionPolicyVersion: integer("admission_policy_version"),
    admissionFreshnessSeconds: integer("admission_freshness_seconds"),
    admissionRequiredCapability: text("admission_required_capability", {
      enum: [
        "node_permission_model",
        "bubblewrap",
        "landlock",
        "seccomp",
        "user_namespace",
        "docker",
        "podman",
      ],
    }),
    admissionReportId: text("admission_report_id"),
    admissionReportReceivedAt: text("admission_report_received_at"),
    admissionEngine: text("admission_engine", {
      enum: ["claude_code_cli", "codex_cli"],
    }),
    admissionEngineReportId: text("admission_engine_report_id"),
    admissionEngineReportReceivedAt: text(
      "admission_engine_report_received_at",
    ),
    admissionEngineVersion: text("admission_engine_version"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("run_leases_run_fence_uidx").on(table.runId, table.fence),
    uniqueIndex("run_leases_active_run_uidx")
      .on(table.runId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("run_leases_active_runner_uidx")
      .on(table.runnerId)
      .where(sql`${table.status} = 'active'`),
    index("run_leases_runner_status_idx").on(table.runnerId, table.status),
    index("run_leases_org_run_idx").on(
      table.organizationId,
      table.runId,
    ),
  ],
);

export const organizationSystemPrincipals = sqliteTable(
  "organization_system_principals",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    purpose: text("purpose", {
      enum: ["deadline_reconciler"],
    }).notNull(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.purpose] }),
    uniqueIndex("organization_system_principals_principal_uidx").on(
      table.principalId,
    ),
    check(
      "organization_system_principals_purpose_check",
      sql`${table.purpose} = 'deadline_reconciler'`,
    ),
  ],
);

export const runDeadlineOperations = sqliteTable(
  "run_deadline_operations",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "restrict" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    operationId: text("operation_id").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    leaseId: text("lease_id").references(() => runLeases.id, {
      onDelete: "restrict",
    }),
    fence: integer("fence"),
    deadlineAt: text("deadline_at").notNull(),
    appliedAt: text("applied_at").notNull(),
    reason: text("reason", {
      enum: ["engine_deadline_exhausted"],
    }).notNull(),
  },
  (table) => [
    uniqueIndex("run_deadline_operations_org_operation_uidx").on(
      table.organizationId,
      table.operationId,
    ),
    index("run_deadline_operations_org_applied_idx").on(
      table.organizationId,
      table.appliedAt,
    ),
    check(
      "run_deadline_operations_reason_check",
      sql`${table.reason} = 'engine_deadline_exhausted'`,
    ),
    check(
      "run_deadline_operations_lease_fence_check",
      sql`(${table.leaseId} IS NULL AND ${table.fence} IS NULL)
        OR (${table.leaseId} IS NOT NULL AND ${table.fence} >= 1)`,
    ),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    sequence: integer("sequence").notNull(),
    kind: text("kind", {
      enum: [
        "run.created",
        "lease.claimed",
        "lease.renewed",
        "lease.superseded",
        "lease.released",
        "lease.revoked",
        "run.cancel_requested",
        "run.completed",
        "run.canceled",
        "run.expired",
      ],
    }).notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => principals.id),
    fence: integer("fence"),
    occurredAt: text("occurred_at").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    index("run_events_org_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);

export const runnerLeaseNonces = sqliteTable(
  "runner_lease_nonces",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id),
    nonce: text("nonce").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body").notNull(),
    occurredAt: text("occurred_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runnerId, table.nonce] }),
    index("runner_lease_nonces_expires_idx").on(table.expiresAt),
  ],
);

export const runnerOperations = sqliteTable(
  "runner_operations",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    operationId: text("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    fence: integer("fence").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body"),
    replayCount: integer("replay_count").notNull().default(0),
    appliedAt: text("applied_at").notNull(),
    compactedAt: text("compacted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.operationId] }),
    index("runner_operations_applied_idx").on(table.appliedAt),
    index("runner_operations_compacted_idx").on(table.compactedAt),
  ],
);

export const runEngineExcerpts = sqliteTable(
  "run_engine_excerpts",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "restrict" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    excerptRef: text("excerpt_ref").notNull(),
    cipherVersion: integer("cipher_version").notNull(),
    keyId: text("key_id"),
    iv: blob("iv", { mode: "buffer" }),
    ciphertext: blob("ciphertext", { mode: "buffer" }),
    tag: blob("tag", { mode: "buffer" }),
    stdoutExcerptBytes: integer("stdout_excerpt_bytes").notNull(),
    stderrExcerptBytes: integer("stderr_excerpt_bytes").notNull(),
    excerptSha256: text("excerpt_sha256").notNull(),
    createdAt: text("created_at").notNull(),
    erasedAt: text("erased_at"),
  },
  (table) => [
    uniqueIndex("run_engine_excerpts_org_ref_uidx").on(
      table.organizationId,
      table.excerptRef,
    ),
    index("run_engine_excerpts_live_key_idx")
      .on(table.keyId, table.runId)
      .where(sql`${table.erasedAt} IS NULL`),
    index("run_engine_excerpts_retention_due_idx").on(
      table.erasedAt,
      table.createdAt,
      table.runId,
    ),
    check(
      "run_engine_excerpts_cipher_version_check",
      sql`${table.cipherVersion} = 1`,
    ),
    check(
      "run_engine_excerpts_bytes_check",
      sql`${table.stdoutExcerptBytes} BETWEEN 0 AND 1024
        AND ${table.stderrExcerptBytes} BETWEEN 0 AND 1024
        AND ${table.stdoutExcerptBytes} + ${table.stderrExcerptBytes} <= 1024`,
    ),
    check(
      "run_engine_excerpts_sha256_check",
      sql`length(${table.excerptSha256}) = 64
        AND ${table.excerptSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "run_engine_excerpts_crypto_state_check",
      sql`(
        ${table.erasedAt} IS NULL
        AND ${table.keyId} IS NOT NULL
        AND ${table.iv} IS NOT NULL
        AND ${table.ciphertext} IS NOT NULL
        AND ${table.tag} IS NOT NULL
      ) OR (
        ${table.erasedAt} IS NOT NULL
        AND ${table.keyId} IS NULL
        AND ${table.iv} IS NULL
        AND ${table.ciphertext} IS NULL
        AND ${table.tag} IS NULL
      )`,
    ),
  ],
);

export const runEngineReceipts = sqliteTable(
  "run_engine_receipts",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "restrict" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    operationId: text("operation_id").notNull(),
    excerptRef: text("excerpt_ref").notNull(),
    excerptSha256: text("excerpt_sha256").notNull(),
    leaseId: text("lease_id")
      .notNull()
      .references(() => runLeases.id, { onDelete: "restrict" }),
    fence: integer("fence").notNull(),
    engine: text("engine", {
      enum: ["claude_code_cli", "codex_cli"],
    }).notNull(),
    engineVersion: text("engine_version").notNull(),
    status: text("status", {
      enum: ["succeeded", "failed", "canceled"],
    }).notNull(),
    reason: text("reason", {
      enum: [
        "none",
        "engine_incompatible",
        "prompt_unavailable",
        "prompt_erased",
        "prompt_integrity_mismatch",
        "spawn_failed",
        "timed_out",
        "cancel_requested",
        "lease_lost",
        "output_limit_reached",
        "interrupted_after_start",
        "orphan_identity_ambiguous",
        "engine_exit_nonzero",
        "protocol_invalid",
      ],
    }).notNull(),
    exitCode: integer("exit_code"),
    timedOut: integer("timed_out", { mode: "boolean" }).notNull(),
    cancelRequested: integer("cancel_requested", {
      mode: "boolean",
    }).notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at").notNull(),
    stdoutBytes: integer("stdout_bytes").notNull(),
    stdoutSha256: text("stdout_sha256").notNull(),
    stdoutTruncated: integer("stdout_truncated", {
      mode: "boolean",
    }).notNull(),
    stdoutExcerptBytes: integer("stdout_excerpt_bytes").notNull(),
    stderrBytes: integer("stderr_bytes").notNull(),
    stderrSha256: text("stderr_sha256").notNull(),
    stderrTruncated: integer("stderr_truncated", {
      mode: "boolean",
    }).notNull(),
    stderrExcerptBytes: integer("stderr_excerpt_bytes").notNull(),
    receiptSha256: text("receipt_sha256").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_engine_receipts_org_operation_uidx").on(
      table.organizationId,
      table.operationId,
    ),
    index("run_engine_receipts_org_recorded_idx").on(
      table.organizationId,
      table.recordedAt,
    ),
    foreignKey({
      columns: [table.runId, table.operationId],
      foreignColumns: [
        runnerOperations.runId,
        runnerOperations.operationId,
      ],
      name: "run_engine_receipts_operation_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.excerptRef],
      foreignColumns: [
        runEngineExcerpts.organizationId,
        runEngineExcerpts.excerptRef,
      ],
      name: "run_engine_receipts_excerpt_fk",
    }).onDelete("restrict"),
    check(
      "run_engine_receipts_fence_check",
      sql`${table.fence} >= 1`,
    ),
    check(
      "run_engine_receipts_engine_check",
      sql`${table.engine} IN ('claude_code_cli', 'codex_cli')`,
    ),
    check(
      "run_engine_receipts_status_check",
      sql`${table.status} IN ('succeeded', 'failed', 'canceled')`,
    ),
    check(
      "run_engine_receipts_reason_check",
      sql`${table.reason} IN (
        'none', 'engine_incompatible', 'prompt_unavailable',
        'prompt_erased', 'prompt_integrity_mismatch',
        'spawn_failed', 'timed_out', 'cancel_requested', 'lease_lost',
        'output_limit_reached', 'interrupted_after_start',
        'orphan_identity_ambiguous', 'engine_exit_nonzero',
        'protocol_invalid'
      )`,
    ),
    check(
      "run_engine_receipts_exit_code_check",
      sql`${table.exitCode} IS NULL
        OR ${table.exitCode} BETWEEN 0 AND 255`,
    ),
    check(
      "run_engine_receipts_stream_bytes_check",
      sql`${table.stdoutBytes} BETWEEN 0 AND 262144
        AND ${table.stderrBytes} BETWEEN 0 AND 65536
        AND ${table.stdoutExcerptBytes} BETWEEN 0 AND 1024
        AND ${table.stderrExcerptBytes} BETWEEN 0 AND 1024
        AND ${table.stdoutExcerptBytes} + ${table.stderrExcerptBytes} <= 1024`,
    ),
    check(
      "run_engine_receipts_digests_check",
      sql`length(${table.stdoutSha256}) = 64
        AND ${table.stdoutSha256} NOT GLOB '*[^0-9a-f]*'
        AND length(${table.stderrSha256}) = 64
        AND ${table.stderrSha256} NOT GLOB '*[^0-9a-f]*'
        AND length(${table.excerptSha256}) = 64
        AND ${table.excerptSha256} NOT GLOB '*[^0-9a-f]*'
        AND length(${table.receiptSha256}) = 64
        AND ${table.receiptSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    objective: text("objective").notNull(),
    status: text("status", { enum: ["active", "paused", "archived"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("projects_org_slug_uidx").on(
      table.organizationId,
      table.slug,
    ),
    index("projects_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    mission: text("mission").notNull(),
    status: text("status", { enum: ["active", "paused", "archived"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("teams_project_slug_uidx").on(table.projectId, table.slug),
    index("teams_org_status_idx").on(table.organizationId, table.status),
    index("teams_project_status_idx").on(table.projectId, table.status),
  ],
);

export const modelConnections = sqliteTable(
  "model_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    provider: text("provider").notNull(),
    authMethod: text("auth_method", { enum: ["oauth", "cli"] }).notNull(),
    label: text("label").notNull(),
    status: text("status", {
      enum: ["disconnected", "ready", "attention", "archived"],
    })
      .notNull()
      .default("disconnected"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    lastVerifiedAt: text("last_verified_at"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("model_connections_org_provider_label_uidx").on(
      table.organizationId,
      table.provider,
      table.label,
    ),
    index("model_connections_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const agentDefinitions = sqliteTable(
  "agent_definitions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    connectionId: text("connection_id").references(() => modelConnections.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    model: text("model").notNull(),
    memoryScope: text("memory_scope", {
      enum: ["run", "project", "team", "governed_episodic"],
    })
      .notNull()
      .default("project"),
    autonomyLevel: text("autonomy_level", {
      enum: ["A0", "A1", "A2", "A3"],
    })
      .notNull()
      .default("A1"),
    status: text("status", { enum: ["active", "paused", "archived"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agent_definitions_principal_uidx").on(table.principalId),
    uniqueIndex("agent_definitions_org_slug_uidx").on(
      table.organizationId,
      table.slug,
    ),
    index("agent_definitions_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("agent_definitions_connection_idx").on(table.connectionId),
  ],
);

export const teamMembers = sqliteTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    assignmentRole: text("assignment_role").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("team_members_team_principal_uidx").on(
      table.teamId,
      table.principalId,
    ),
    index("team_members_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("team_members_principal_idx").on(table.principalId),
  ],
);

export const objectives = sqliteTable(
  "objectives",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", {
      enum: ["open", "active", "completed", "cancelled"],
    })
      .notNull()
      .default("open"),
    priority: text("priority", { enum: ["p0", "p1", "p2", "p3"] })
      .notNull()
      .default("p1"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("objectives_org_ref_uidx").on(
      table.organizationId,
      table.ref,
    ),
    index("objectives_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("objectives_project_status_idx").on(table.projectId, table.status),
  ],
);

export const workItems = sqliteTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    objectiveId: text("objective_id").references(() => objectives.id),
    ref: text("ref").notNull(),
    kind: text("kind", { enum: ["task", "bug", "spike", "story"] })
      .notNull()
      .default("task"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", {
      enum: [
        "backlog",
        "ready",
        "in_progress",
        "blocked",
        "in_review",
        "done",
        "cancelled",
      ],
    })
      .notNull()
      .default("backlog"),
    priority: text("priority", { enum: ["p0", "p1", "p2", "p3"] })
      .notNull()
      .default("p1"),
    assigneeId: text("assignee_id").references(() => principals.id),
    externalRef: text("external_ref"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("work_items_org_ref_uidx").on(
      table.organizationId,
      table.ref,
    ),
    uniqueIndex("work_items_org_external_ref_uidx").on(
      table.organizationId,
      table.externalRef,
    ),
    index("work_items_project_status_idx").on(table.projectId, table.status),
    index("work_items_objective_status_idx").on(
      table.objectiveId,
      table.status,
    ),
    index("work_items_assignee_idx").on(table.assigneeId),
  ],
);

export const artifactPayloads = sqliteTable(
  "artifact_payloads",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    contentHash: text("content_hash").notNull(),
    byteSize: integer("byte_size").notNull(),
    bodyText: text("body_text"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    erasedAt: text("erased_at"),
  },
  (table) => [
    index("artifact_payloads_org_hash_idx").on(
      table.organizationId,
      table.contentHash,
    ),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id),
    title: text("title").notNull(),
    mediaType: text("media_type", { enum: ["text/markdown"] })
      .notNull()
      .default("text/markdown"),
    currentVersion: integer("current_version").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => principals.id),
    ...timestamps,
  },
  (table) => [
    index("artifacts_org_updated_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
    index("artifacts_work_item_updated_idx").on(
      table.workItemId,
      table.updatedAt,
    ),
  ],
);

export const artifactVersions = sqliteTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    versionNumber: integer("version_number").notNull(),
    contentRef: text("content_ref")
      .notNull()
      .references(() => artifactPayloads.id),
    contentHash: text("content_hash").notNull(),
    byteSize: integer("byte_size").notNull(),
    note: text("note").notNull().default(""),
    createdBy: text("created_by")
      .notNull()
      .references(() => principals.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("artifact_versions_artifact_number_uidx").on(
      table.artifactId,
      table.versionNumber,
    ),
    index("artifact_versions_org_artifact_idx").on(
      table.organizationId,
      table.artifactId,
    ),
    index("artifact_versions_org_content_hash_idx").on(
      table.organizationId,
      table.contentHash,
    ),
  ],
);

export const artifactReviews = sqliteTable(
  "artifact_reviews",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    artifactVersionId: text("artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id),
    versionNumber: integer("version_number").notNull(),
    contentHash: text("content_hash").notNull(),
    byteSize: integer("byte_size").notNull(),
    verdict: text("verdict", {
      enum: ["approved", "changes_requested"],
    }).notNull(),
    reasonCode: text("reason_code", {
      enum: [
        "accurate",
        "complete",
        "needs_correction",
        "needs_evidence",
        "outdated",
      ],
    }).notNull(),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => principals.id),
    selfReviewPolicy: text("self_review_policy", {
      enum: ["solo_owner_ack"],
    }),
    status: text("status", { enum: ["active", "superseded"] })
      .notNull()
      .default("active"),
    supersedesReviewId: text("supersedes_review_id").references(
      (): AnySQLiteColumn => artifactReviews.id,
    ),
    supersededBy: text("superseded_by").references(() => principals.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    supersededAt: text("superseded_at"),
  },
  (table) => [
    uniqueIndex("artifact_reviews_active_reviewer_uidx")
      .on(table.artifactVersionId, table.reviewerId)
      .where(sql`${table.status} = 'active'`),
    index("artifact_reviews_org_version_idx").on(
      table.organizationId,
      table.artifactVersionId,
    ),
    uniqueIndex("artifact_reviews_supersedes_uidx")
      .on(table.supersedesReviewId)
      .where(sql`${table.supersedesReviewId} IS NOT NULL`),
  ],
);

export const artifactSupersessions = sqliteTable(
  "artifact_supersessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    sourceArtifactId: text("source_artifact_id")
      .notNull()
      .references(() => artifacts.id),
    sourceVersionId: text("source_version_id")
      .notNull()
      .references(() => artifactVersions.id),
    sourceVersionNumber: integer("source_version_number").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    sourceByteSize: integer("source_byte_size").notNull(),
    targetArtifactId: text("target_artifact_id")
      .notNull()
      .references(() => artifacts.id),
    targetVersionId: text("target_version_id")
      .notNull()
      .references(() => artifactVersions.id),
    targetVersionNumber: integer("target_version_number").notNull(),
    targetContentHash: text("target_content_hash").notNull(),
    targetByteSize: integer("target_byte_size").notNull(),
    relationType: text("relation_type", {
      enum: ["supersedes"],
    })
      .notNull()
      .default("supersedes"),
    reasonCode: text("reason_code", {
      enum: [
        "replaced_by_revision",
        "duplicate_output",
        "scope_moved",
      ],
    }).notNull(),
    status: text("status", { enum: ["active", "retracted"] })
      .notNull()
      .default("active"),
    declaredBy: text("declared_by")
      .notNull()
      .references(() => principals.id),
    declaredAt: text("declared_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    retractionReasonCode: text("retraction_reason_code", {
      enum: ["declared_in_error", "no_longer_accurate"],
    }),
    retractedBy: text("retracted_by").references(() => principals.id),
    retractedAt: text("retracted_at"),
  },
  (table) => [
    uniqueIndex("artifact_supersessions_active_source_uidx")
      .on(table.organizationId, table.sourceArtifactId)
      .where(sql`${table.status} = 'active'`),
    index("artifact_supersessions_org_target_active_idx")
      .on(table.organizationId, table.targetArtifactId)
      .where(sql`${table.status} = 'active'`),
    index("artifact_supersessions_org_source_history_idx").on(
      table.organizationId,
      table.sourceArtifactId,
      table.declaredAt,
    ),
  ],
);

export const actionIntents = sqliteTable(
  "action_intents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    proposerId: text("proposer_id")
      .notNull()
      .references(() => principals.id),
    proposerKind: text("proposer_kind", {
      enum: ["human", "agent", "automation", "policy", "runner"],
    }).notNull(),
    actionType: text("action_type").notNull(),
    targetRef: text("target_ref").notNull(),
    parametersJson: text("parameters_json").notNull(),
    parametersHash: text("parameters_hash").notNull(),
    preconditionsJson: text("preconditions_json").notNull().default("[]"),
    riskTier: text("risk_tier", {
      enum: ["low", "medium", "high", "critical"],
    }).notNull(),
    policyDecisionJson: text("policy_decision_json").notNull(),
    requiredApprovals: integer("required_approvals").notNull().default(1),
    separationOfDuties: integer("separation_of_duties", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    selfApprovalPolicy: text("self_approval_policy", {
      enum: ["solo_owner"],
    }),
    expiresAt: text("expires_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: [
        "draft",
        "proposed",
        "approved",
        "rejected",
        "expired",
        "cancelled",
        "executing",
        "succeeded",
        "failed",
        "interrupted",
      ],
    })
      .notNull()
      .default("draft"),
    supersedesIntentId: text("supersedes_intent_id"),
    fencingToken: integer("fencing_token"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("action_intents_org_live_idempotency_uidx")
      .on(table.organizationId, table.idempotencyKey)
      .where(
        sql`${table.status} IN ('draft', 'proposed', 'approved', 'executing')`,
      ),
    index("action_intents_project_status_idx").on(
      table.projectId,
      table.status,
    ),
  ],
);

export const intentArtifactEvidence = sqliteTable(
  "intent_artifact_evidence",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    intentId: text("intent_id")
      .notNull()
      .references(() => actionIntents.id),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    artifactVersionId: text("artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id),
    contentHash: text("content_hash").notNull(),
    byteSize: integer("byte_size").notNull(),
    relation: text("relation", { enum: ["basis", "outcome"] }).notNull(),
    status: text("status", { enum: ["active", "superseded"] })
      .notNull()
      .default("active"),
    addedBy: text("added_by")
      .notNull()
      .references(() => principals.id),
    supersededBy: text("superseded_by").references(() => principals.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    supersededAt: text("superseded_at"),
  },
  (table) => [
    uniqueIndex("intent_artifact_evidence_active_uidx")
      .on(table.intentId, table.artifactVersionId, table.relation)
      .where(sql`${table.status} = 'active'`),
    index("intent_artifact_evidence_org_intent_idx").on(
      table.organizationId,
      table.intentId,
    ),
    index("intent_artifact_evidence_version_idx").on(
      table.artifactVersionId,
    ),
  ],
);

export const attentionItems = sqliteTable(
  "attention_items",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    intentId: text("intent_id")
      .notNull()
      .references(() => actionIntents.id),
    kind: text("kind", { enum: ["intent_awaiting_approval"] })
      .notNull()
      .default("intent_awaiting_approval"),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status", { enum: ["open", "seen", "resolved"] })
      .notNull()
      .default("open"),
    resolution: text("resolution", {
      enum: ["decided", "expired", "superseded"],
    }),
    version: integer("version").notNull().default(1),
    seenAt: text("seen_at"),
    resolvedAt: text("resolved_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("attention_items_org_principal_dedupe_uidx").on(
      table.organizationId,
      table.principalId,
      table.dedupeKey,
    ),
    index("attention_items_org_principal_status_created_idx").on(
      table.organizationId,
      table.principalId,
      table.status,
      table.createdAt,
    ),
    index("attention_items_org_principal_created_idx").on(
      table.organizationId,
      table.principalId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const intentApprovals = sqliteTable(
  "intent_approvals",
  {
    id: text("id").primaryKey(),
    intentId: text("intent_id")
      .notNull()
      .references(() => actionIntents.id),
    actorId: text("actor_id")
      .notNull()
      .references(() => principals.id),
    actorKind: text("actor_kind", {
      enum: ["human", "agent", "automation", "policy", "runner"],
    }).notNull(),
    parametersHash: text("parameters_hash").notNull(),
    soloOwnerAcknowledged: integer("solo_owner_acknowledged", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    approvedAt: text("approved_at").notNull(),
  },
  (table) => [
    uniqueIndex("intent_approvals_intent_actor_uidx").on(
      table.intentId,
      table.actorId,
    ),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    teamId: text("team_id").references(() => teams.id),
    workItemId: text("work_item_id").references(() => workItems.id),
    intentId: text("intent_id").references(() => actionIntents.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => principals.id),
    kind: text("kind", { enum: ["direct", "room", "handoff"] }).notNull(),
    directKey: text("direct_key"),
    title: text("title").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    nextSequence: integer("next_sequence").notNull().default(1),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("conversations_org_direct_key_uidx").on(
      table.organizationId,
      table.directKey,
    ),
    index("conversations_org_kind_status_idx").on(
      table.organizationId,
      table.kind,
      table.status,
    ),
    index("conversations_project_idx").on(table.projectId),
    index("conversations_team_idx").on(table.teamId),
  ],
);

export const conversationMembers = sqliteTable(
  "conversation_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    role: text("role", { enum: ["owner", "member", "observer"] })
      .notNull()
      .default("member"),
    status: text("status", { enum: ["active", "left", "removed"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    leftAt: text("left_at"),
  },
  (table) => [
    uniqueIndex("conversation_members_conv_principal_uidx").on(
      table.conversationId,
      table.principalId,
    ),
    index("conversation_members_org_principal_idx").on(
      table.organizationId,
      table.principalId,
    ),
  ],
);

export const presenceSessions = sqliteTable(
  "presence_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    sessionKey: text("session_key").notNull(),
    fencingToken: integer("fencing_token").notNull().default(1),
    status: text("status", { enum: ["available", "focus", "dnd"] })
      .notNull()
      .default("available"),
    roomConversationId: text("room_conversation_id").references(
      () => conversations.id,
    ),
    expiresAtEpoch: integer("expires_at_epoch").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("presence_sessions_org_principal_uidx").on(
      table.organizationId,
      table.principalId,
    ),
    index("presence_sessions_org_expires_idx").on(
      table.organizationId,
      table.expiresAtEpoch,
    ),
    index("presence_sessions_room_idx").on(table.roomConversationId),
  ],
);

export const messagePayloads = sqliteTable(
  "message_payloads",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    bodyText: text("body_text"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    erasedAt: text("erased_at"),
  },
  (table) => [
    index("message_payloads_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    senderId: text("sender_id")
      .notNull()
      .references(() => principals.id),
    contentRef: text("content_ref").references(() => messagePayloads.id),
    contentHash: text("content_hash").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind", {
      enum: ["text", "system", "context_pin", "handoff_transfer"],
    })
      .notNull()
      .default("text"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("messages_conv_sequence_uidx").on(
      table.conversationId,
      table.sequence,
    ),
    index("messages_org_conv_idx").on(
      table.organizationId,
      table.conversationId,
    ),
    index("messages_sender_idx").on(table.senderId),
  ],
);

export const conversationPins = sqliteTable(
  "conversation_pins",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    pinnedBy: text("pinned_by")
      .notNull()
      .references(() => principals.id),
    status: text("status", { enum: ["active", "removed"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    pinnedAt: text("pinned_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    unpinnedAt: text("unpinned_at"),
  },
  (table) => [
    uniqueIndex("conversation_pins_conv_message_uidx").on(
      table.conversationId,
      table.messageId,
    ).where(sql`${table.status} = 'active'`),
    index("conversation_pins_org_conv_status_idx").on(
      table.organizationId,
      table.conversationId,
      table.status,
    ),
  ],
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    sequence: integer("sequence").notNull(),
    kind: text("kind", {
      enum: [
        "intent.proposed",
        "intent.approved",
        "intent.rejected",
        "intent.expired",
        "effect.started",
        "effect.step",
        "effect.succeeded",
        "effect.failed",
        "decision.recorded",
        "artifact.registered",
        "evidence.linked",
        "evidence.superseded",
        "review.recorded",
        "review.superseded",
        "supersession.declared",
        "supersession.retracted",
        "runner_token.issued",
        "runner_token.revoked",
        "runner.enrolled",
        "runner.revoked",
        "runner_policy.updated",
        "run.requested",
        "run.completed",
        "run.expired",
        "release.deployed",
      ],
    }).notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => principals.id),
    occurredAt: text("occurred_at").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payloadRef: text("payload_ref"),
    intentId: text("intent_id").references(() => actionIntents.id),
    runId: text("run_id"),
    previousHash: text("previous_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (table) => [
    uniqueIndex("ledger_entries_org_sequence_uidx").on(
      table.organizationId,
      table.sequence,
    ),
    uniqueIndex("ledger_entries_org_hash_uidx").on(
      table.organizationId,
      table.hash,
    ),
    index("ledger_entries_intent_idx").on(table.intentId),
    index("ledger_entries_org_payload_kind_idx")
      .on(table.organizationId, table.payloadRef, table.kind)
      .where(sql`${table.payloadRef} IS NOT NULL`),
  ],
);
