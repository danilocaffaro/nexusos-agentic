import { getD1 } from "@/db";
import type {
  ObjectiveStatus,
  WorkItemKind,
  WorkItemStatus,
  WorkPriority,
} from "@/src/contracts/work-graph";
import {
  assertObjectiveTransition,
  assertWorkItemTransition,
  WorkGraphTransitionError,
} from "@/src/domain/work-graph";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  requireWorkspaceOwner,
  WorkspaceRepositoryError,
} from "./workspace-repository";

type JsonRecord = Record<string, unknown>;

const OBJECTIVE_STATUSES = ["open", "active", "completed", "cancelled"] as const;
const WORK_ITEM_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
] as const;
const WORK_ITEM_KINDS = ["task", "bug", "spike", "story"] as const;
const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;

export async function createObjective(
  identity: RequestIdentity,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const projectId = requiredText(input.projectId, "projectId", 100);
  await requireActiveProject(identity.organizationId, projectId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const objective = {
    id,
    projectId,
    ref: generatedRef("OBJ", id),
    title: requiredText(input.title, "title", 160),
    description: optionalDescription(input.description, 2_000) ?? "",
    priority: optionalEnum(input.priority, PRIORITIES) ?? "p1",
  };
  await execute(
    getD1()
      .prepare(
        `INSERT INTO objectives (
          id, organization_id, project_id, ref, title, description, priority,
          status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`,
      )
      .bind(
        objective.id,
        identity.organizationId,
        objective.projectId,
        objective.ref,
        objective.title,
        objective.description,
        objective.priority,
        now,
        now,
      ),
  );
  return {
    ...objective,
    status: "open" as const,
    version: 1,
    created_at: now,
    updated_at: now,
  };
}

export async function updateObjective(
  identity: RequestIdentity,
  objectiveId: string,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const current = await requireObjective(identity.organizationId, objectiveId);
  const expectedVersion = requiredVersion(input.expectedVersion);
  const status =
    optionalEnum(input.status, OBJECTIVE_STATUSES) ?? current.status;
  if (status !== current.status) {
    translateTransition(() =>
      assertObjectiveTransition(current.status, status),
    );
  }
  if (status === "completed" || status === "cancelled") {
    const activeItem = await getD1()
      .prepare(
        `SELECT id FROM work_items
         WHERE organization_id = ? AND objective_id = ?
           AND status NOT IN ('done', 'cancelled')
         LIMIT 1`,
      )
      .bind(identity.organizationId, objectiveId)
      .first();
    if (activeItem) {
      throw new WorkspaceRepositoryError(
        "objective_has_active_work_items",
        409,
      );
    }
  }
  const now = new Date().toISOString();
  await executeChanged(
    getD1()
      .prepare(
        `UPDATE objectives
         SET title = ?, description = ?, priority = ?, status = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND (
             ? NOT IN ('completed', 'cancelled') OR NOT EXISTS (
               SELECT 1 FROM work_items
               WHERE organization_id = ? AND objective_id = ?
                 AND status NOT IN ('done', 'cancelled')
             )
           )`,
      )
      .bind(
        optionalText(input.title, "title", 160) ?? current.title,
        optionalDescription(input.description, 2_000) ?? current.description,
        optionalEnum(input.priority, PRIORITIES) ?? current.priority,
        status,
        now,
        objectiveId,
        identity.organizationId,
        expectedVersion,
        status,
        identity.organizationId,
        objectiveId,
      ),
  );
  return {
    id: objectiveId,
    status,
    version: expectedVersion + 1,
    updated_at: now,
  };
}

export async function createWorkItem(
  identity: RequestIdentity,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const projectId = requiredText(input.projectId, "projectId", 100);
  const objectiveId = optionalNullableId(input.objectiveId, "objectiveId");
  const assigneeId = optionalNullableId(input.assigneeId, "assigneeId");
  await requireWorkReferences(
    identity.organizationId,
    projectId,
    objectiveId,
    assigneeId,
  );
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const workItem = {
    id,
    projectId,
    objectiveId,
    ref: generatedRef("WI", id),
    kind: optionalEnum(input.kind, WORK_ITEM_KINDS) ?? "task",
    title: requiredText(input.title, "title", 200),
    description: optionalDescription(input.description, 4_000) ?? "",
    priority: optionalEnum(input.priority, PRIORITIES) ?? "p1",
    assigneeId,
  };
  await execute(
    getD1()
      .prepare(
        `INSERT INTO work_items (
          id, organization_id, project_id, objective_id, ref, kind, title,
          description, priority, assignee_id, status, version, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', 1, ?, ?)`,
      )
      .bind(
        workItem.id,
        identity.organizationId,
        workItem.projectId,
        workItem.objectiveId,
        workItem.ref,
        workItem.kind,
        workItem.title,
        workItem.description,
        workItem.priority,
        workItem.assigneeId,
        now,
        now,
      ),
  );
  return {
    ...workItem,
    status: "backlog" as const,
    version: 1,
    created_at: now,
    updated_at: now,
  };
}

export async function updateWorkItem(
  identity: RequestIdentity,
  workItemId: string,
  input: JsonRecord,
) {
  await requireWorkspaceOwner(identity);
  const current = await requireWorkItem(identity.organizationId, workItemId);
  const expectedVersion = requiredVersion(input.expectedVersion);
  const objectiveId =
    input.objectiveId === undefined
      ? current.objective_id
      : optionalNullableId(input.objectiveId, "objectiveId");
  const assigneeId =
    input.assigneeId === undefined
      ? current.assignee_id
      : optionalNullableId(input.assigneeId, "assigneeId");
  await requireWorkReferences(
    identity.organizationId,
    current.project_id,
    input.objectiveId === undefined ? null : objectiveId,
    input.assigneeId === undefined ? null : assigneeId,
  );
  const status =
    optionalEnum(input.status, WORK_ITEM_STATUSES) ?? current.status;
  if (status !== current.status) {
    translateTransition(() =>
      assertWorkItemTransition(current.status, status),
    );
  }
  const now = new Date().toISOString();
  await executeChanged(
    getD1()
      .prepare(
        `UPDATE work_items
         SET objective_id = ?, kind = ?, title = ?, description = ?,
             priority = ?, assignee_id = ?, status = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?`,
      )
      .bind(
        objectiveId,
        optionalEnum(input.kind, WORK_ITEM_KINDS) ?? current.kind,
        optionalText(input.title, "title", 200) ?? current.title,
        optionalDescription(input.description, 4_000) ?? current.description,
        optionalEnum(input.priority, PRIORITIES) ?? current.priority,
        assigneeId,
        status,
        now,
        workItemId,
        identity.organizationId,
        expectedVersion,
      ),
  );
  return {
    id: workItemId,
    status,
    version: expectedVersion + 1,
    updated_at: now,
  };
}

async function requireWorkReferences(
  organizationId: string,
  projectId: string,
  objectiveId: string | null,
  assigneeId: string | null,
): Promise<void> {
  await requireActiveProject(organizationId, projectId);
  if (objectiveId) {
    const objective = await getD1()
      .prepare(
        `SELECT id FROM objectives
         WHERE id = ? AND organization_id = ? AND project_id = ?
           AND status IN ('open', 'active')`,
      )
      .bind(objectiveId, organizationId, projectId)
      .first();
    if (!objective) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
  }
  if (assigneeId) {
    const assignee = await getD1()
      .prepare(
        `SELECT id FROM principals
         WHERE id = ? AND organization_id = ? AND status = 'active'
           AND NOT EXISTS (
             SELECT 1
             FROM organization_system_principals system_principal
             WHERE system_principal.organization_id =
                 principals.organization_id
               AND system_principal.principal_id = principals.id
           )`,
      )
      .bind(assigneeId, organizationId)
      .first();
    if (!assignee) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
  }
}

async function requireActiveProject(
  organizationId: string,
  projectId: string,
): Promise<void> {
  const project = await getD1()
    .prepare(
      `SELECT id FROM projects
       WHERE id = ? AND organization_id = ? AND status != 'archived'`,
    )
    .bind(projectId, organizationId)
    .first();
  if (!project) {
    throw new WorkspaceRepositoryError("invalid_reference", 422);
  }
}

async function requireObjective(
  organizationId: string,
  objectiveId: string,
): Promise<ObjectiveRow> {
  const objective = await getD1()
    .prepare("SELECT * FROM objectives WHERE id = ? AND organization_id = ?")
    .bind(objectiveId, organizationId)
    .first<ObjectiveRow>();
  if (!objective) {
    throw new WorkspaceRepositoryError("entity_not_found", 404);
  }
  return objective;
}

async function requireWorkItem(
  organizationId: string,
  workItemId: string,
): Promise<WorkItemRow> {
  const workItem = await getD1()
    .prepare("SELECT * FROM work_items WHERE id = ? AND organization_id = ?")
    .bind(workItemId, organizationId)
    .first<WorkItemRow>();
  if (!workItem) {
    throw new WorkspaceRepositoryError("entity_not_found", 404);
  }
  return workItem;
}

async function execute(statement: D1PreparedStatement): Promise<D1Result> {
  try {
    return await statement.run();
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/i.test(error.message)
    ) {
      throw new WorkspaceRepositoryError("duplicate_entity", 409);
    }
    if (
      error instanceof Error &&
      /(FOREIGN KEY constraint failed|invalid_workspace_reference)/i.test(
        error.message,
      )
    ) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
    throw error;
  }
}

async function executeChanged(statement: D1PreparedStatement): Promise<void> {
  const result = await execute(statement);
  if (result.meta.changes < 1) {
    throw new WorkspaceRepositoryError("version_conflict", 409);
  }
}

function translateTransition(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof WorkGraphTransitionError) {
      throw new WorkspaceRepositoryError(error.code, 400);
    }
    throw error;
  }
}

function generatedRef(prefix: "OBJ" | "WI", id: string): string {
  return `${prefix}-${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
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

function optionalDescription(
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new WorkspaceRepositoryError("invalid_description", 400);
  }
  return value.trim();
}

function optionalNullableId(
  value: unknown,
  field: string,
): string | null {
  return value === undefined || value === null
    ? null
    : requiredText(value, field, 100);
}

function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new WorkspaceRepositoryError("invalid_expectedVersion", 400);
  }
  return Number(value);
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw new WorkspaceRepositoryError("invalid_enum_value", 400);
  }
  return value as T[number];
}

type ObjectiveRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: ObjectiveStatus;
  priority: WorkPriority;
  version: number;
};

type WorkItemRow = {
  id: string;
  project_id: string;
  objective_id: string | null;
  kind: WorkItemKind;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkPriority;
  assignee_id: string | null;
  version: number;
};
