import type {
  ObjectiveStatus,
  WorkItemStatus,
} from "@/src/contracts/work-graph";

const OBJECTIVE_TRANSITIONS: Record<ObjectiveStatus, ObjectiveStatus[]> = {
  open: ["active", "cancelled"],
  active: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  backlog: ["ready", "cancelled"],
  ready: ["backlog", "in_progress", "cancelled"],
  in_progress: ["ready", "blocked", "in_review", "done", "cancelled"],
  blocked: ["ready", "in_progress", "cancelled"],
  in_review: ["in_progress", "blocked", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["backlog"],
};

export class WorkGraphTransitionError extends Error {
  constructor(
    readonly code: "invalid_status_transition",
    message: string,
  ) {
    super(message);
    this.name = "WorkGraphTransitionError";
  }
}

export function assertObjectiveTransition(
  current: ObjectiveStatus,
  next: ObjectiveStatus,
): void {
  assertTransition("objective", current, next, OBJECTIVE_TRANSITIONS);
}

export function assertWorkItemTransition(
  current: WorkItemStatus,
  next: WorkItemStatus,
): void {
  assertTransition("work item", current, next, WORK_ITEM_TRANSITIONS);
}

function assertTransition<T extends string>(
  entity: string,
  current: T,
  next: T,
  transitions: Record<T, T[]>,
): void {
  if (!transitions[current].includes(next)) {
    throw new WorkGraphTransitionError(
      "invalid_status_transition",
      `Cannot transition ${entity} from ${current} to ${next}`,
    );
  }
}
