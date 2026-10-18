import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HiveManager } from "./hive";
import type { GoalStatus } from "../shared/goals";
import { GoalStatus as GOAL_STATUSES } from "../shared/goals";
import type { TaskState } from "../shared/taskStateMachine";
import { TaskState as TASK_STATES } from "../shared/taskStateMachine";
import type { TaskPlan } from "../shared/goalRecord";
import type { GoalTaskEvent, GoalTaskRecord, GoalRecord, GoalsFile } from "../shared/goalRecord";
import { GOALS_SCHEMA_VERSION, MAX_EVENTS_PER_TASK, MAX_PROCESSED_MESSAGES } from "../shared/goalRecord";

// The record types live in shared/goalRecord (renderer + preload + main all read
// them); re-exported here so main-side imports from ./goalStore keep working.
export { GOALS_SCHEMA_VERSION, MAX_EVENTS_PER_TASK, MAX_PROCESSED_MESSAGES };
export type { GoalTaskEvent, GoalTaskRecord, GoalRecord, GoalsFile };

export interface ValidationIssue {
  where: string;
  detail: string;
}

export interface ValidationOutcome {
  ok: boolean;
  doc: GoalsFile;
  issues: ValidationIssue[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function strArray(v: unknown, cap: number): string[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length > cap) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function isGoalStatus(v: unknown): v is GoalStatus {
  return typeof v === "string" && Object.values(GOAL_STATUSES).includes(v as GoalStatus);
}

function isTaskState(v: unknown): v is TaskState {
  return typeof v === "string" && Object.values(TASK_STATES).includes(v as TaskState);
}

function isSessionState(v: unknown): v is GoalTaskRecord["sessionState"] {
  return v === "live" || v === "starting" || v === "offline" || v === "unknown";
}

function validatePlan(raw: unknown, where: string, issues: ValidationIssue[]): TaskPlan | null {
  if (!isPlainObject(raw)) {
    issues.push({ where, detail: "plan is not an object" });
    return null;
  }
  const id = str(raw.id);
  const title = str(raw.title);
  const description = str(raw.description);
  const dependencies = strArray(raw.dependencies, 100);
  const acceptanceCriteria = strArray(raw.acceptanceCriteria, 50);
  if (!id || title === null || description === null || !dependencies || !acceptanceCriteria) {
    issues.push({ where, detail: "plan missing/invalid required fields" });
    return null;
  }
  const requirements = isPlainObject(raw.requirements)
    ? (raw.requirements as TaskPlan["requirements"])
    : {};
  return {
    id,
    title,
    description,
    requirements,
    dependencies,
    acceptanceCriteria,
    requiresApproval: raw.requiresApproval === true,
  };
}

function validateTask(raw: unknown, where: string, issues: ValidationIssue[]): GoalTaskRecord | null {
  if (!isPlainObject(raw)) {
    issues.push({ where, detail: "task is not an object" });
    return null;
  }
  const planId = str(raw.planId);
  if (!planId || !isTaskState(raw.state)) {
    issues.push({ where, detail: "task missing planId/state" });
    return null;
  }
  const eventsRaw = Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS_PER_TASK) : [];
  const events: GoalTaskEvent[] = [];
  for (const e of eventsRaw) {
    if (!isPlainObject(e)) continue;
    const at = str(e.at);
    const kind = str(e.kind);
    if (!at || !kind) continue;
    events.push({ at, kind, detail: str(e.detail) ?? "", messageId: str(e.messageId) ?? undefined });
  }
  return {
    planId,
    state: raw.state,
    agentId: str(raw.agentId),
    agentName: str(raw.agentName),
    agentRole: str(raw.agentRole),
    dispatchMessageId: str(raw.dispatchMessageId),
    attempts: typeof raw.attempts === "number" && raw.attempts >= 0 ? Math.floor(raw.attempts) : 0,
    maxAttempts:
      typeof raw.maxAttempts === "number" && raw.maxAttempts > 0 ? Math.floor(raw.maxAttempts) : 3,
    sessionState: isSessionState(raw.sessionState) ? raw.sessionState : "unknown",
    result: str(raw.result),
    error: str(raw.error),
    events,
    updatedAt: str(raw.updatedAt) ?? new Date().toISOString(),
  };
}

function validateGoal(raw: unknown, where: string, issues: ValidationIssue[]): GoalRecord | null {
  if (!isPlainObject(raw)) {
    issues.push({ where, detail: "goal is not an object" });
    return null;
  }
  const id = str(raw.id);
  const title = str(raw.title);
  if (!id || title === null || !isGoalStatus(raw.status)) {
    issues.push({ where, detail: "goal missing id/title/status" });
    return null;
  }
  const plans: TaskPlan[] = [];
  const plansRaw = Array.isArray(raw.plans) ? raw.plans : [];
  for (const p of plansRaw) {
    const plan = validatePlan(p, `${where}.plans`, issues);
    if (plan) plans.push(plan);
  }
  const tasks: GoalTaskRecord[] = [];
  const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];
  for (const t of tasksRaw) {
    const task = validateTask(t, `${where}.tasks`, issues);
    if (task) tasks.push(task);
  }
  const processed =
    strArray(raw.processedMessageIds, MAX_PROCESSED_MESSAGES)?.slice(-MAX_PROCESSED_MESSAGES) ?? [];
  return {
    id,
    title,
    description: str(raw.description) ?? "",
    status: raw.status,
    taskIds: plans.map((p) => p.id),
    createdBy: str(raw.createdBy) ?? "human",
    createdAt: str(raw.createdAt) ?? new Date().toISOString(),
    updatedAt: str(raw.updatedAt) ?? new Date().toISOString(),
    completedAt: str(raw.completedAt),
    plans,
    tasks,
    processedMessageIds: processed,
  };
}

/** Validate a parsed goals.json document. Unknown versions / unparseable shapes
 *  fail with ok:false so the caller can quarantine the file rather than trust it. */
export function validateGoalsFile(raw: unknown): ValidationOutcome {
  const issues: ValidationIssue[] = [];
  const empty: GoalsFile = { version: GOALS_SCHEMA_VERSION, savedAt: new Date().toISOString(), goals: [] };
  if (!isPlainObject(raw)) {
    return { ok: false, doc: empty, issues: [{ where: "$", detail: "not an object" }] };
  }
  if (raw.version !== GOALS_SCHEMA_VERSION) {
    return {
      ok: false,
      doc: empty,
      issues: [{ where: "$.version", detail: `unsupported version: ${String(raw.version)}` }],
    };
  }
  if (!Array.isArray(raw.goals)) {
    return { ok: false, doc: empty, issues: [{ where: "$.goals", detail: "not an array" }] };
  }
  const goals: GoalRecord[] = [];
  for (const g of raw.goals) {
    const goal = validateGoal(g, "goals", issues);
    if (goal) goals.push(goal);
  }
  // Fatal only when the container itself lies about its shape; per-entry issues
  // drop the entry and keep the rest (documented in the integration plan).
  return { ok: true, doc: { version: GOALS_SCHEMA_VERSION, savedAt: str(raw.savedAt) ?? new Date().toISOString(), goals }, issues };
}

/**
 * Versioned, atomic `<hive>/goals.json` store.
 *
 * - Single writer: the Electron main process (same ownership rule as tasks.json).
 * - Writes are temp+rename (same discipline as roster.json / config.json), so a
 *   crash mid-write leaves the previous file intact.
 * - Reads validate the schema; an unparseable or wrong-version file is
 *   quarantined to `goals.json.corrupt-<ts>` and a fresh document is started —
 *   data is never silently overwritten.
 * - Every mutation goes through `mutate()` (read-modify-write in one tick) and
 *   rides the existing hive git commit so goals are versioned with the hive.
 */
export class GoalStore {
  private cache: GoalsFile | null = null;

  constructor(private hive: HiveManager) {}

  private path(): string | null {
    const root = this.hive.root();
    return root ? join(root, "goals.json") : null;
  }

  /** Load (or return the cached) document. Corrupt files are quarantined. */
  load(): GoalsFile {
    if (this.cache) return this.cache;
    const p = this.path();
    if (!p || !existsSync(p)) {
      this.cache = {
        version: GOALS_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        goals: [],
      };
      return this.cache;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      parsed = null;
    }
    const outcome = validateGoalsFile(parsed);
    if (!outcome.ok) {
      const quarantined = `${p}.corrupt-${Date.now().toString(36)}`;
      try {
        renameSync(p, quarantined);
      } catch {
        /* best effort — a stuck quarantine must not block startup */
      }
      try {
        this.hive.appendLog({ kind: "goals-corrupt", quarantined, issues: outcome.issues });
      } catch {
        /* logging is best effort */
      }
      this.cache = { version: GOALS_SCHEMA_VERSION, savedAt: new Date().toISOString(), goals: [] };
      return this.cache;
    }
    if (outcome.issues.length > 0) {
      try {
        this.hive.appendLog({ kind: "goals-issues", issues: outcome.issues });
      } catch {
        /* best effort */
      }
    }
    this.cache = outcome.doc;
    return this.cache;
  }

  get(): GoalsFile {
    return this.load();
  }

  findGoal(id: string): GoalRecord | undefined {
    return this.load().goals.find((g) => g.id === id);
  }

  /** Read-modify-write + persist + commit. The callback mutates the live doc;
   *  an exception from the write propagates so the caller can report failure. */
  mutate(fn: (doc: GoalsFile) => void): GoalsFile {
    const doc = this.load();
    fn(doc);
    this.persist(doc);
    return doc;
  }

  persist(doc: GoalsFile): void {
    const p = this.path();
    if (!p) throw new Error("goals store unavailable (no hive root)");
    doc.savedAt = new Date().toISOString();
    const tmp = `${p}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
      renameSync(tmp, p);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore cleanup failure */
      }
      throw err;
    }
    this.cache = doc;
    try {
      this.hive.commit(`hive: goals (${doc.goals.length})`);
    } catch {
      /* commit failure must not lose the already-written file */
    }
  }
}
