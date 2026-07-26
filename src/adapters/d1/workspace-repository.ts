import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import { ensureLocalWorkspace } from "@/src/adapters/d1/local-workspace";

type JsonRecord = Record<string, unknown>;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONNECTION_METADATA_KEYS = new Set([
  "accountLabel",
  "plan",
  "cliPath",
  "poolLabel",
  "scopes",
]);

export async function listWorkspace(identity: RequestIdentity) {
  await requireWorkspaceOwner(identity);
  const d1 = getD1();
  const [projectResult, teamResult, connectionResult, agentResult, assignmentResult] =
    await Promise.all([
      d1
        .prepare(
          `SELECT id, slug, name, objective, status, version, created_at, updated_at
           FROM projects
           WHERE organization_id = ?
           ORDER BY created_at, id`,
        )
        .bind(identity.organizationId)
        .all<WorkspaceProject>(),
      d1
        .prepare(
          `SELECT
             t.id, t.project_id, t.slug, t.name, t.mission, t.status, t.version,
             t.created_at, t.updated_at,
             SUM(CASE WHEN tm.status = 'active' AND p.status = 'active' AND p.kind = 'human' THEN 1 ELSE 0 END) AS human_count,
             SUM(CASE WHEN tm.status = 'active' AND p.status = 'active' AND p.kind = 'agent' THEN 1 ELSE 0 END) AS agent_count
           FROM teams t
           LEFT JOIN team_members tm ON tm.team_id = t.id
           LEFT JOIN principals p ON p.id = tm.principal_id
           WHERE t.organization_id = ?
           GROUP BY t.id
           ORDER BY t.created_at, t.id`,
        )
        .bind(identity.organizationId)
        .all<WorkspaceTeam>(),
      d1
        .prepare(
          `SELECT id, provider, auth_method, label, status, metadata_json,
                  last_verified_at, version, created_at, updated_at
           FROM model_connections
           WHERE organization_id = ?
           ORDER BY created_at, id`,
        )
        .bind(identity.organizationId)
        .all<WorkspaceConnectionRow>(),
      d1
        .prepare(
          `SELECT
             a.id, a.principal_id, a.connection_id, a.slug, a.name, a.role,
             a.model, a.memory_scope, a.autonomy_level, a.status, a.version,
             a.created_at, a.updated_at,
             c.provider, c.auth_method, c.label AS connection_label,
             c.status AS connection_status
           FROM agent_definitions a
           LEFT JOIN model_connections c
             ON c.id = a.connection_id AND c.organization_id = a.organization_id
           WHERE a.organization_id = ?
           ORDER BY a.created_at, a.id`,
        )
        .bind(identity.organizationId)
        .all<WorkspaceAgent>(),
      d1
        .prepare(
          `SELECT team_id, principal_id, assignment_role, status, version
           FROM team_members
           WHERE organization_id = ?
           ORDER BY created_at, id`,
        )
        .bind(identity.organizationId)
        .all<WorkspaceAssignment>(),
    ]);

  return {
    projects: projectResult.results,
    teams: teamResult.results,
    connections: connectionResult.results.map((connection) => ({
      ...connection,
      metadata: parseMetadata(connection.metadata_json),
      metadata_json: undefined,
    })),
    agents: agentResult.results.map((agent) => ({
      ...agent,
      teamIds: assignmentResult.results
        .filter(
          (assignment) =>
            assignment.principal_id === agent.principal_id &&
            assignment.status === "active",
        )
        .map((assignment) => assignment.team_id),
    })),
    assignments: assignmentResult.results,
  };
}

export async function createProject(
  identity: RequestIdentity,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const project = {
    id: crypto.randomUUID(),
    slug: requiredSlug(input.slug),
    name: requiredText(input.name, "name", 80),
    objective: requiredText(input.objective, "objective", 500),
  };
  const now = new Date().toISOString();
  await executeStatements([
    getD1()
      .prepare(
        `INSERT INTO projects (
          id, organization_id, slug, name, objective, status, version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      )
      .bind(
        project.id,
        identity.organizationId,
        project.slug,
        project.name,
        project.objective,
        now,
        now,
      ),
  ]);
  return { ...project, status: "active", version: 1, created_at: now, updated_at: now };
}

export async function updateProject(
  identity: RequestIdentity,
  projectId: string,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const current = await requireEntity<WorkspaceProject>(
    identity.organizationId,
    "projects",
    projectId,
  );
  const expectedVersion = requiredVersion(input.expectedVersion);
  const status = optionalEnum(input.status, [
    "active",
    "paused",
    "archived",
  ] as const) ?? current.status;
  if (status === "archived" && current.status !== "archived") {
    const activeTeam = await getD1()
      .prepare(
        "SELECT id FROM teams WHERE organization_id = ? AND project_id = ? AND status != 'archived' LIMIT 1",
      )
      .bind(identity.organizationId, projectId)
      .first();
    if (activeTeam) {
      throw new WorkspaceRepositoryError("project_has_active_teams", 409);
    }
  }
  const now = new Date().toISOString();
  const result = await mutateOne(
    getD1()
      .prepare(
        `UPDATE projects
         SET name = ?, objective = ?, status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND (
             ? != 'archived' OR NOT EXISTS (
               SELECT 1 FROM teams
               WHERE organization_id = ? AND project_id = ?
                 AND status != 'archived'
             )
           )`,
      )
      .bind(
        optionalText(input.name, "name", 80) ?? current.name,
        optionalText(input.objective, "objective", 500) ?? current.objective,
        status,
        now,
        projectId,
        identity.organizationId,
        expectedVersion,
        status,
        identity.organizationId,
        projectId,
      ),
  );
  assertChanged(result);
  return { id: projectId, status, version: expectedVersion + 1, updated_at: now };
}

export async function createTeam(
  identity: RequestIdentity,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const projectId = requiredText(input.projectId, "projectId", 100);
  await requireActiveReference(identity.organizationId, "projects", projectId);
  const team = {
    id: crypto.randomUUID(),
    projectId,
    slug: requiredSlug(input.slug),
    name: requiredText(input.name, "name", 80),
    mission: requiredText(input.mission, "mission", 500),
  };
  const now = new Date().toISOString();
  await executeStatements([
    getD1()
      .prepare(
        `INSERT INTO teams (
          id, organization_id, project_id, slug, name, mission, status,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      )
      .bind(
        team.id,
        identity.organizationId,
        team.projectId,
        team.slug,
        team.name,
        team.mission,
        now,
        now,
      ),
  ]);
  return { ...team, status: "active", version: 1, created_at: now, updated_at: now };
}

export async function updateTeam(
  identity: RequestIdentity,
  teamId: string,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const current = await requireEntity<WorkspaceTeam>(
    identity.organizationId,
    "teams",
    teamId,
  );
  const expectedVersion = requiredVersion(input.expectedVersion);
  const status = optionalEnum(input.status, [
    "active",
    "paused",
    "archived",
  ] as const) ?? current.status;
  if (status === "archived" && current.status !== "archived") {
    const activeMember = await getD1()
      .prepare(
        `SELECT tm.id
         FROM team_members tm
         INNER JOIN principals p ON p.id = tm.principal_id
         WHERE tm.organization_id = ? AND tm.team_id = ?
           AND tm.status = 'active' AND p.status = 'active'
         LIMIT 1`,
      )
      .bind(identity.organizationId, teamId)
      .first();
    if (activeMember) {
      throw new WorkspaceRepositoryError("team_has_active_members", 409);
    }
  }
  const now = new Date().toISOString();
  const result = await mutateOne(
    getD1()
      .prepare(
        `UPDATE teams
         SET name = ?, mission = ?, status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND (
             ? != 'archived' OR NOT EXISTS (
               SELECT 1
               FROM team_members tm
               INNER JOIN principals p ON p.id = tm.principal_id
               WHERE tm.organization_id = ? AND tm.team_id = ?
                 AND tm.status = 'active' AND p.status = 'active'
             )
           )`,
      )
      .bind(
        optionalText(input.name, "name", 80) ?? current.name,
        optionalText(input.mission, "mission", 500) ?? current.mission,
        status,
        now,
        teamId,
        identity.organizationId,
        expectedVersion,
        status,
        identity.organizationId,
        teamId,
      ),
  );
  assertChanged(result);
  return { id: teamId, status, version: expectedVersion + 1, updated_at: now };
}

export async function createConnection(
  identity: RequestIdentity,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const connection = {
    id: crypto.randomUUID(),
    provider: requiredText(input.provider, "provider", 60),
    authMethod: requiredEnum(input.authMethod, ["oauth", "cli"] as const),
    label: requiredText(input.label, "label", 100),
    metadata: sanitizeConnectionMetadata(input.metadata),
  };
  const now = new Date().toISOString();
  await executeStatements([
    getD1()
      .prepare(
        `INSERT INTO model_connections (
          id, organization_id, provider, auth_method, label, status,
          metadata_json, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'disconnected', ?, 1, ?, ?)`,
      )
      .bind(
        connection.id,
        identity.organizationId,
        connection.provider,
        connection.authMethod,
        connection.label,
        JSON.stringify(connection.metadata),
        now,
        now,
      ),
  ]);
  return { ...connection, status: "disconnected", version: 1 };
}

export async function updateConnection(
  identity: RequestIdentity,
  connectionId: string,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const current = await requireEntity<WorkspaceConnectionRow>(
    identity.organizationId,
    "model_connections",
    connectionId,
  );
  const expectedVersion = requiredVersion(input.expectedVersion);
  const status = optionalEnum(input.status, [
    "disconnected",
    "ready",
    "attention",
    "archived",
  ] as const) ?? current.status;
  if (status === "archived" && current.status !== "archived") {
    const activeAgent = await getD1()
      .prepare(
        "SELECT id FROM agent_definitions WHERE organization_id = ? AND connection_id = ? AND status != 'archived' LIMIT 1",
      )
      .bind(identity.organizationId, connectionId)
      .first();
    if (activeAgent) {
      throw new WorkspaceRepositoryError("connection_has_active_agents", 409);
    }
  }
  const metadata =
    input.metadata === undefined
      ? parseMetadata(current.metadata_json)
      : sanitizeConnectionMetadata(input.metadata);
  const now = new Date().toISOString();
  const result = await mutateOne(
    getD1()
      .prepare(
        `UPDATE model_connections
         SET label = ?, status = ?, metadata_json = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND (
             ? != 'archived' OR NOT EXISTS (
               SELECT 1 FROM agent_definitions
               WHERE organization_id = ? AND connection_id = ?
                 AND status != 'archived'
             )
           )`,
      )
      .bind(
        optionalText(input.label, "label", 100) ?? current.label,
        status,
        JSON.stringify(metadata),
        now,
        connectionId,
        identity.organizationId,
        expectedVersion,
        status,
        identity.organizationId,
        connectionId,
      ),
  );
  assertChanged(result);
  return { id: connectionId, status, version: expectedVersion + 1 };
}

export async function createAgent(
  identity: RequestIdentity,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const teamId = requiredText(input.teamId, "teamId", 100);
  await requireActiveReference(identity.organizationId, "teams", teamId);
  const connectionId =
    input.connectionId === null || input.connectionId === undefined
      ? null
      : requiredText(input.connectionId, "connectionId", 100);
  if (connectionId) {
    await requireActiveReference(
      identity.organizationId,
      "model_connections",
      connectionId,
    );
  }
  const name = requiredText(input.name, "name", 80);
  const role = requiredText(input.role, "role", 120);
  const agent = {
    id: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    membershipId: crypto.randomUUID(),
    slug: requiredSlug(input.slug),
    name,
    role,
    model: requiredText(input.model, "model", 100),
    memoryScope: requiredEnum(input.memoryScope, [
      "run",
      "project",
      "team",
      "governed_episodic",
    ] as const),
    autonomyLevel: requiredEnum(input.autonomyLevel, [
      "A0",
      "A1",
      "A2",
      "A3",
    ] as const),
  };
  const now = new Date().toISOString();
  const d1 = getD1();
  await executeStatements([
    d1
      .prepare(
        `INSERT INTO principals (
          id, organization_id, kind, external_id, display_name, status,
          created_at, updated_at
        ) VALUES (?, ?, 'agent', ?, ?, 'active', ?, ?)`,
      )
      .bind(
        agent.principalId,
        identity.organizationId,
        `nexus:agent:${agent.id}`,
        agent.name,
        now,
        now,
      ),
    d1
      .prepare(
        `INSERT INTO agent_definitions (
          id, organization_id, principal_id, connection_id, slug, name, role,
          model, memory_scope, autonomy_level, status, version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      )
      .bind(
        agent.id,
        identity.organizationId,
        agent.principalId,
        connectionId,
        agent.slug,
        agent.name,
        agent.role,
        agent.model,
        agent.memoryScope,
        agent.autonomyLevel,
        now,
        now,
      ),
    d1
      .prepare(
        `INSERT INTO team_members (
          id, organization_id, team_id, principal_id, assignment_role,
          status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      )
      .bind(
        agent.membershipId,
        identity.organizationId,
        teamId,
        agent.principalId,
        agent.role,
        now,
        now,
      ),
  ]);
  return {
    id: agent.id,
    principalId: agent.principalId,
    teamId,
    connectionId,
    slug: agent.slug,
    name: agent.name,
    role: agent.role,
    model: agent.model,
    memoryScope: agent.memoryScope,
    autonomyLevel: agent.autonomyLevel,
    status: "active",
    version: 1,
  };
}

export async function updateAgent(
  identity: RequestIdentity,
  agentId: string,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const current = await requireEntity<WorkspaceAgent>(
    identity.organizationId,
    "agent_definitions",
    agentId,
  );
  const expectedVersion = requiredVersion(input.expectedVersion);
  const connectionId =
    input.connectionId === undefined
      ? current.connection_id
      : input.connectionId === null
        ? null
        : requiredText(input.connectionId, "connectionId", 100);
  if (connectionId) {
    await requireActiveReference(
      identity.organizationId,
      "model_connections",
      connectionId,
    );
  }
  const status = optionalEnum(input.status, [
    "active",
    "paused",
    "archived",
  ] as const) ?? current.status;
  const name = optionalText(input.name, "name", 80) ?? current.name;
  const role = optionalText(input.role, "role", 120) ?? current.role;
  const now = new Date().toISOString();
  const result = await mutateOne(
    getD1()
      .prepare(
        `UPDATE agent_definitions
         SET connection_id = ?, name = ?, role = ?, model = ?,
             memory_scope = ?, autonomy_level = ?, status = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?`,
      )
      .bind(
        connectionId,
        name,
        role,
        optionalText(input.model, "model", 100) ?? current.model,
        optionalEnum(input.memoryScope, [
          "run",
          "project",
          "team",
          "governed_episodic",
        ] as const) ?? current.memory_scope,
        optionalEnum(input.autonomyLevel, [
          "A0",
          "A1",
          "A2",
          "A3",
        ] as const) ?? current.autonomy_level,
        status,
        now,
        agentId,
        identity.organizationId,
        expectedVersion,
      ),
  );
  assertChanged(result);
  return { id: agentId, status, version: expectedVersion + 1, updated_at: now };
}

export async function requireWorkspaceOwner(
  identity: RequestIdentity,
): Promise<void> {
  await ensureLocalWorkspace();
  const access = await getD1()
    .prepare(
      `SELECT m.role
       FROM memberships m
       INNER JOIN principals p ON p.id = m.principal_id
       WHERE m.organization_id = ? AND m.principal_id = ?
         AND m.status = 'active' AND p.status = 'active' AND p.kind = 'human'
       LIMIT 1`,
    )
    .bind(identity.organizationId, identity.id)
    .first<{ role: string }>();
  if (!access || !["owner", "admin"].includes(access.role)) {
    throw new WorkspaceRepositoryError("workspace_owner_required", 403);
  }
}

async function requireEntity<T>(
  organizationId: string,
  table: "projects" | "teams" | "model_connections" | "agent_definitions",
  entityId: string,
): Promise<T> {
  const entity = await getD1()
    .prepare(`SELECT * FROM ${table} WHERE id = ? AND organization_id = ?`)
    .bind(entityId, organizationId)
    .first<T>();
  if (!entity) {
    throw new WorkspaceRepositoryError("entity_not_found", 404);
  }
  return entity;
}

async function requireActiveReference(
  organizationId: string,
  table: "projects" | "teams" | "model_connections",
  entityId: string,
): Promise<void> {
  const entity = await getD1()
    .prepare(
      `SELECT id FROM ${table} WHERE id = ? AND organization_id = ? AND status != 'archived'`,
    )
    .bind(entityId, organizationId)
    .first();
  if (!entity) {
    throw new WorkspaceRepositoryError("invalid_reference", 422);
  }
}

async function executeStatements(
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  try {
    return await getD1().batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/i.test(error.message)
    ) {
      throw new WorkspaceRepositoryError("duplicate_entity", 409);
    }
    if (
      error instanceof Error &&
      /FOREIGN KEY constraint failed/i.test(error.message)
    ) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
    if (
      error instanceof Error &&
      /invalid_workspace_reference/i.test(error.message)
    ) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
    throw error;
  }
}

async function mutateOne(statement: D1PreparedStatement): Promise<D1Result> {
  const [result] = await executeStatements([statement]);
  return result;
}

function assertChanged(result: D1Result | undefined): void {
  if (!result || result.meta.changes < 1) {
    throw new WorkspaceRepositoryError("version_conflict", 409);
  }
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new WorkspaceRepositoryError(`invalid_${field}`, 400);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new WorkspaceRepositoryError(`invalid_${field}`, 400);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, max);
}

function requiredSlug(value: unknown): string {
  const slug = requiredText(value, "slug", 80);
  if (!SLUG_PATTERN.test(slug)) {
    throw new WorkspaceRepositoryError("invalid_slug", 400);
  }
  return slug;
}

function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new WorkspaceRepositoryError("invalid_expectedVersion", 400);
  }
  return Number(value);
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new WorkspaceRepositoryError("invalid_enum_value", 400);
  }
  return value as T[number];
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | undefined {
  return value === undefined ? undefined : requiredEnum(value, values);
}

function sanitizeConnectionMetadata(value: unknown): JsonRecord {
  if (value === undefined) {
    return {};
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new WorkspaceRepositoryError("invalid_connection_metadata", 400);
  }
  const metadata = value as JsonRecord;
  for (const [key, entry] of Object.entries(metadata)) {
    if (
      !CONNECTION_METADATA_KEYS.has(key) ||
      /(token|secret|credential|api.?key|password)/i.test(key)
    ) {
      throw new WorkspaceRepositoryError("sensitive_metadata_rejected", 400);
    }
    const validScalar =
      typeof entry === "string" &&
      entry.length > 0 &&
      entry.length <= 300;
    const validScopes =
      key === "scopes" &&
      Array.isArray(entry) &&
      entry.length <= 30 &&
      entry.every(
        (scope) => typeof scope === "string" && scope.length <= 100,
      );
    if (!validScalar && !validScopes) {
      throw new WorkspaceRepositoryError("invalid_connection_metadata", 400);
    }
  }
  return metadata;
}

function parseMetadata(value: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && !Array.isArray(parsed) && typeof parsed === "object"
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

export class WorkspaceRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "WorkspaceRepositoryError";
  }
}

type WorkspaceProject = {
  id: string;
  slug: string;
  name: string;
  objective: string;
  status: "active" | "paused" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
};

type WorkspaceTeam = {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  mission: string;
  status: "active" | "paused" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
  human_count: number;
  agent_count: number;
};

type WorkspaceConnectionRow = {
  id: string;
  provider: string;
  auth_method: "oauth" | "cli";
  label: string;
  status: "disconnected" | "ready" | "attention" | "archived";
  metadata_json: string;
  last_verified_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type WorkspaceAgent = {
  id: string;
  principal_id: string;
  connection_id: string | null;
  slug: string;
  name: string;
  role: string;
  model: string;
  memory_scope: "run" | "project" | "team" | "governed_episodic";
  autonomy_level: "A0" | "A1" | "A2" | "A3";
  status: "active" | "paused" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
  provider: string | null;
  auth_method: "oauth" | "cli" | null;
  connection_label: string | null;
  connection_status: string | null;
};

type WorkspaceAssignment = {
  team_id: string;
  principal_id: string;
  assignment_role: string;
  status: "active" | "archived";
  version: number;
};
