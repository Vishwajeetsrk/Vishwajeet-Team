/** Pure input validators for the `ceo:*` IPC surface.
 *  House style: no schema library — explicit type/shape/range guards returning
 *  `{ ok:false, error }` instead of throwing (matches hive and pty handlers).
 *  Kept free of Electron so tests can exercise every branch directly. */

export const LIMITS = {
  title: 300,
  description: 5000,
  tasks: 50,
  roles: 20,
  skills: 20,
  dependencyIndexes: 50,
  acceptanceCriteria: 30,
  stringItem: 200,
  criterionItem: 1000,
} as const;

export interface CreateGoalTaskInput {
  title: string;
  description: string;
  roles: string[];
  skills: string[];
  /** Indexes into the submitted task list (resolved to plan ids in main). */
  dependencies: number[];
  acceptanceCriteria: string[];
  requiresApproval: boolean;
}

export interface CreateGoalInput {
  title: string;
  description: string;
  tasks: CreateGoalTaskInput[];
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function checkString(v: unknown, field: string, max: number, min = 1): string | null {
  if (typeof v !== "string") return `${field} must be a string`;
  if (v.trim().length < min) return `${field} must be at least ${min} character(s)`;
  if (v.length > max) return `${field} exceeds ${max} characters`;
  return null;
}

type ListOutcome = { ok: true; value: string[] } | { ok: false; error: string };

function checkStringList(v: unknown, field: string, cap: number, itemMax: number): ListOutcome {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, error: `${field} must be an array` };
  if (v.length > cap) return { ok: false, error: `${field} exceeds ${cap} items` };
  for (const item of v) {
    if (typeof item !== "string") return { ok: false, error: `${field} entries must be strings` };
    if (item.length > itemMax) return { ok: false, error: `${field} entries exceed ${itemMax} characters` };
  }
  return { ok: true, value: v as string[] };
}

export function validateCreateGoal(raw: unknown): ValidationResult<CreateGoalInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid goal payload");
  const input = raw as Record<string, unknown>;

  const titleErr = checkString(input.title, "title", LIMITS.title);
  if (titleErr) return fail(titleErr);

  let description = "";
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") return fail("description must be a string");
    if (input.description.length > LIMITS.description) return fail(`description exceeds ${LIMITS.description} characters`);
    description = input.description;
  }

  const tasksRaw = input.tasks;
  if (tasksRaw !== undefined && tasksRaw !== null && !Array.isArray(tasksRaw)) {
    return fail("tasks must be an array");
  }
  const tasksList = (tasksRaw as unknown[] | undefined) ?? [];
  if (tasksList.length === 0) return fail("at least one task is required");
  if (tasksList.length > LIMITS.tasks) return fail(`tasks exceeds ${LIMITS.tasks} entries`);

  const tasks: CreateGoalTaskInput[] = [];
  for (let i = 0; i < tasksList.length; i++) {
    const t = tasksList[i];
    if (!t || typeof t !== "object" || Array.isArray(t)) return fail(`tasks[${i}] must be an object`);
    const task = t as Record<string, unknown>;

    const tTitleErr = checkString(task.title, `tasks[${i}].title`, LIMITS.title);
    if (tTitleErr) return fail(tTitleErr);

    let tDescription = "";
    if (task.description !== undefined && task.description !== null) {
      if (typeof task.description !== "string") return fail(`tasks[${i}].description must be a string`);
      if (task.description.length > LIMITS.description) return fail(`tasks[${i}].description exceeds ${LIMITS.description} characters`);
      tDescription = task.description;
    }

    const roles = checkStringList(task.roles, `tasks[${i}].roles`, LIMITS.roles, LIMITS.stringItem);
    if (!roles.ok) return fail(roles.error);
    const skills = checkStringList(task.skills, `tasks[${i}].skills`, LIMITS.skills, LIMITS.stringItem);
    if (!skills.ok) return fail(skills.error);
    const criteria = checkStringList(task.acceptanceCriteria, `tasks[${i}].acceptanceCriteria`, LIMITS.acceptanceCriteria, LIMITS.criterionItem);
    if (!criteria.ok) return fail(criteria.error);

    const depsRaw = task.dependencies;
    if (depsRaw !== undefined && depsRaw !== null && !Array.isArray(depsRaw)) {
      return fail(`tasks[${i}].dependencies must be an array`);
    }
    const deps = (depsRaw as unknown[] | undefined) ?? [];
    if (deps.length > LIMITS.dependencyIndexes) return fail(`tasks[${i}].dependencies exceeds ${LIMITS.dependencyIndexes} entries`);
    const dependencyIndexes: number[] = [];
    for (const d of deps) {
      if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d >= tasksList.length) {
        return fail(`tasks[${i}].dependencies contains an out-of-range index`);
      }
      if (d === i) return fail(`tasks[${i}].dependencies must not reference itself`);
      dependencyIndexes.push(d);
    }

    if (task.requiresApproval !== undefined && typeof task.requiresApproval !== "boolean") {
      return fail(`tasks[${i}].requiresApproval must be a boolean`);
    }

    tasks.push({
      title: task.title as string,
      description: tDescription,
      roles: roles.value,
      skills: skills.value,
      dependencies: dependencyIndexes,
      acceptanceCriteria: criteria.value,
      requiresApproval: task.requiresApproval === true,
    });
  }

  // A default task mirrors the goal command so a one-line submission works.
  return {
    ok: true,
    value: { title: (input.title as string).trim(), description, tasks },
  };
}

export function validateGoalRef(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) return fail("goalId must be a non-empty string");
  if (raw.length > 200) return fail("goalId too long");
  return { ok: true, value: raw };
}

export function validateTaskRef(raw: unknown): ValidationResult<{ goalId: string; planId: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid task reference");
  const ref = raw as Record<string, unknown>;
  if (typeof ref.goalId !== "string" || ref.goalId.trim().length === 0) return fail("goalId must be a non-empty string");
  if (typeof ref.planId !== "string" || ref.planId.trim().length === 0) return fail("planId must be a non-empty string");
  if (ref.goalId.length > 200 || ref.planId.length > 200) return fail("reference too long");
  return { ok: true, value: { goalId: ref.goalId, planId: ref.planId } };
}

export function validateAgentRef(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) return fail("agentId must be a non-empty string");
  if (raw.length > 200) return fail("agentId too long");
  return { ok: true, value: raw };
}
