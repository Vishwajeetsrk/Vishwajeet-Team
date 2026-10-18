import type { Goal } from "./goals";
import type { TaskState } from "./taskStateMachine";
import type { TaskRequirements } from "./agentSelection";

/** Schema version of `<hive>/goals.json`. A mismatch is quarantined, not merged. */
export const GOALS_SCHEMA_VERSION = 1;
export const MAX_EVENTS_PER_TASK = 100;
export const MAX_PROCESSED_MESSAGES = 500;

/** Orchestrator task plan: what to do, for whom, and how it is accepted. */
export interface TaskPlan {
  id: string;
  title: string;
  description: string;
  requirements: TaskRequirements;
  dependencies: string[];
  acceptanceCriteria: string[];
  requiresApproval: boolean;
}

export interface GoalTaskEvent {
  at: string;
  kind: string;
  detail: string;
  messageId?: string;
}

/** Per-task runtime record. `planId` doubles as the hive ledger card id. */
export interface GoalTaskRecord {
  planId: string;
  state: TaskState;
  agentId: string | null;
  agentName: string | null;
  agentRole: string | null;
  dispatchMessageId: string | null;
  attempts: number;
  maxAttempts: number;
  sessionState: "live" | "starting" | "offline" | "unknown";
  result: string | null;
  error: string | null;
  events: GoalTaskEvent[];
  updatedAt: string;
}

/** Durable goal: Goal fields + plans + runtime records + reply dedupe ledger. */
export interface GoalRecord extends Goal {
  plans: TaskPlan[];
  tasks: GoalTaskRecord[];
  processedMessageIds: string[];
}

export interface GoalsFile {
  version: number;
  savedAt: string;
  goals: GoalRecord[];
}
