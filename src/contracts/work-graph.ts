export const OBJECTIVE_STATUSES = [
  "open",
  "active",
  "completed",
  "cancelled",
] as const;

export const WORK_ITEM_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
] as const;

export const WORK_ITEM_KINDS = ["task", "bug", "spike", "story"] as const;
export const WORK_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;

export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];
export type WorkPriority = (typeof WORK_PRIORITIES)[number];
