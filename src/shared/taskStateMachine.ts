export const TaskState = {
  CREATED: "CREATED",
  PLANNED: "PLANNED",
  ASSIGNED: "ASSIGNED",
  RUNNING: "RUNNING",
  REVIEW: "REVIEW",
  COMPLETED: "COMPLETED",
  WAITING: "WAITING",
  BLOCKED: "BLOCKED",
  APPROVAL: "APPROVAL",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  [TaskState.CREATED]: [TaskState.PLANNED, TaskState.CANCELLED],
  [TaskState.PLANNED]: [TaskState.ASSIGNED, TaskState.CANCELLED, TaskState.BLOCKED],
  [TaskState.ASSIGNED]: [TaskState.RUNNING, TaskState.CANCELLED, TaskState.APPROVAL],
  [TaskState.RUNNING]: [TaskState.REVIEW, TaskState.FAILED, TaskState.WAITING, TaskState.BLOCKED, TaskState.CANCELLED],
  [TaskState.REVIEW]: [TaskState.COMPLETED, TaskState.FAILED, TaskState.RUNNING],
  [TaskState.WAITING]: [TaskState.RUNNING, TaskState.BLOCKED, TaskState.CANCELLED],
  [TaskState.BLOCKED]: [TaskState.RUNNING, TaskState.CANCELLED],
  [TaskState.APPROVAL]: [TaskState.ASSIGNED, TaskState.CANCELLED],
  [TaskState.COMPLETED]: [],
  [TaskState.FAILED]: [TaskState.ASSIGNED, TaskState.CANCELLED],
  [TaskState.CANCELLED]: [],
};

export function isValidTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function getAllowedTransitions(from: TaskState): TaskState[] {
  return TRANSITIONS[from] ?? [];
}

export function isTerminalState(state: TaskState): boolean {
  return state === TaskState.COMPLETED || state === TaskState.CANCELLED;
}

export function isActiveState(state: TaskState): boolean {
  return state === TaskState.RUNNING || state === TaskState.REVIEW;
}

export interface StateTransition {
  taskId: string;
  from: TaskState;
  to: TaskState;
  reason: string;
  actorId: string;
  timestamp: string;
}

export function assertValidTransition(from: TaskState, to: TaskState): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`Invalid task state transition: ${from} → ${to}`);
  }
}
