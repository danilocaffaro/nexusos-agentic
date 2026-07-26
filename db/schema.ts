import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
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
