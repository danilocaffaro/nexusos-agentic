import { env } from "cloudflare:workers";
import { getD1 } from "@/db";

export const LOCAL_ORGANIZATION_ID = "org-local-aurora";
export const LOCAL_OWNER_ID = "principal-local-owner";
export const LOCAL_PROJECT_ID = "project-local-nexus";
export const LOCAL_AGENT_ID = "principal-local-atlas";
export const LOCAL_AGENT_DEFINITION_ID = "agent-local-atlas";
export const LOCAL_CONNECTION_ID = "connection-local-claude-cli";
export const LOCAL_TEAM_ID = "team-local-checkout";
export const LOCAL_OBJECTIVE_ID = "objective-local-governed-delivery";
export const LOCAL_WORK_ITEM_ID = "work-local-persistent-graph";

export async function ensureLocalWorkspace(): Promise<void> {
  if (env.NEXUS_ALLOW_LOCAL_IDENTITY !== "1") {
    return;
  }
  const d1 = getD1();
  await d1.batch([
    d1
      .prepare(
        "INSERT OR IGNORE INTO organizations (id, slug, name) VALUES (?, ?, ?)",
      )
      .bind(LOCAL_ORGANIZATION_ID, "aurora-local", "Aurora Local"),
    d1
      .prepare(
        "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        LOCAL_OWNER_ID,
        LOCAL_ORGANIZATION_ID,
        "human",
        "local:owner",
        "Local owner",
      ),
    d1
      .prepare(
        "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        LOCAL_AGENT_ID,
        LOCAL_ORGANIZATION_ID,
        "agent",
        "local:atlas",
        "Atlas",
      ),
    d1
      .prepare(
        "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        "nexus-effect-gateway",
        LOCAL_ORGANIZATION_ID,
        "automation",
        "system:effect-gateway",
        "Nexus effect gateway",
      ),
    d1
      .prepare(
        "INSERT OR IGNORE INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, ?)",
      )
      .bind(
        "membership-local-owner",
        LOCAL_ORGANIZATION_ID,
        LOCAL_OWNER_ID,
        "owner",
      ),
    d1
      .prepare(
        "INSERT OR IGNORE INTO projects (id, organization_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        LOCAL_PROJECT_ID,
        LOCAL_ORGANIZATION_ID,
        "nexus-commerce",
        "Nexus Commerce",
        "Prove the governed execution spine end to end",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO model_connections (
          id, organization_id, provider, auth_method, label, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_CONNECTION_ID,
        LOCAL_ORGANIZATION_ID,
        "Anthropic",
        "cli",
        "Claude Code local",
        "disconnected",
        JSON.stringify({
          cliPath: "claude",
          poolLabel: "local-shell",
        }),
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO teams (
          id, organization_id, project_id, slug, name, mission
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_TEAM_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        "checkout-evolution",
        "Checkout Evolution",
        "Operate the governed NexusOS delivery loop",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO agent_definitions (
          id, organization_id, principal_id, connection_id, slug, name, role,
          model, memory_scope, autonomy_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_AGENT_DEFINITION_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_AGENT_ID,
        LOCAL_CONNECTION_ID,
        "atlas",
        "Atlas",
        "Engineering Lead",
        "Claude Opus",
        "project",
        "A2",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO team_members (
          id, organization_id, team_id, principal_id, assignment_role
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        "team-member-local-owner",
        LOCAL_ORGANIZATION_ID,
        LOCAL_TEAM_ID,
        LOCAL_OWNER_ID,
        "Accountable owner",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO team_members (
          id, organization_id, team_id, principal_id, assignment_role
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        "team-member-local-atlas",
        LOCAL_ORGANIZATION_ID,
        LOCAL_TEAM_ID,
        LOCAL_AGENT_ID,
        "Engineering Lead",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO objectives (
          id, organization_id, project_id, ref, title, description, status,
          priority
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_OBJECTIVE_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        "OBJ-A11CE001",
        "Tornar o NexusOS um operating system agentic confiável",
        "Entregar o caminho persistente de projeto até trabalho governado.",
        "active",
        "p0",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO work_items (
          id, organization_id, project_id, objective_id, ref, kind, title,
          description, status, priority, assignee_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_WORK_ITEM_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        LOCAL_OBJECTIVE_ID,
        "WI-A11CE001",
        "story",
        "Conectar o Work Graph persistente à experiência de projeto",
        "Substituir o kanban demonstrativo pelo lifecycle real do NexusOS.",
        "in_progress",
        "p0",
        LOCAL_AGENT_ID,
      ),
  ]);
}
