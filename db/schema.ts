import { sql } from "drizzle-orm";
import {
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
    uniqueIndex("action_intents_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("action_intents_project_status_idx").on(
      table.projectId,
      table.status,
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
    approvedAt: text("approved_at").notNull(),
  },
  (table) => [
    uniqueIndex("intent_approvals_intent_actor_uidx").on(
      table.intentId,
      table.actorId,
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
  ],
);
