import type { Goal, CreateGoalInput } from "../shared/goals";
import type { TaskState } from "../shared/taskStateMachine";
import { TaskState as TS } from "../shared/taskStateMachine";
import { selectAgentForTask, type AgentCandidate } from "../shared/agentSelection";
import { validateDependencies, detectCycle, getReadyTasks, getBlockedTasks, type DependencyNode } from "../shared/dependencyGraph";
import type { TaskPlan } from "../shared/goalRecord";
import { randomUUID } from "node:crypto";

// TaskPlan lives in shared/goalRecord (the goals file schema is shared with the
// renderer); re-exported so existing `from "./ceo"` type imports keep working.
export type { TaskPlan } from "../shared/goalRecord";

export interface CEODelegationResult {
  success: boolean;
  goalId: string | null;
  taskIds: string[];
  assignments: Array<{ taskId: string; agentId: string; agentName: string }>;
  errors: string[];
  blockedTasks: string[];
}

export class CEOOrchestrator {
  private goals: Map<string, Goal> = new Map();
  private taskPlans: Map<string, TaskPlan> = new Map();

  createGoal(input: CreateGoalInput): Goal {
    const goal: Goal = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      status: "DRAFT",
      taskIds: [],
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.goals.set(goal.id, goal);
    return goal;
  }

  addTaskPlan(goalId: string, plan: TaskPlan): TaskPlan {
    // Preserve a caller-supplied id (Phase 3 persists plans and needs stable
    // ids across restart); generate one only when absent/empty (Phase 2 callers).
    const taskPlan: TaskPlan = { ...plan, id: plan.id || randomUUID() };
    this.taskPlans.set(taskPlan.id, taskPlan);

    const goal = this.goals.get(goalId);
    if (goal) {
      goal.taskIds.push(taskPlan.id);
      goal.updatedAt = new Date().toISOString();
    }

    return taskPlan;
  }

  validatePlan(goalId: string): { valid: boolean; errors: string[] } {
    const goal = this.goals.get(goalId);
    if (!goal) return { valid: false, errors: [`Goal ${goalId} not found`] };

    const plans = goal.taskIds
      .map((id) => this.taskPlans.get(id))
      .filter((p): p is TaskPlan => p !== undefined);

    const nodes: DependencyNode[] = plans.map((p) => ({
      id: p.id,
      dependencies: p.dependencies,
    }));

    const existingIds = new Set(plans.map((p) => p.id));
    const depValidation = validateDependencies(nodes, existingIds);
    const cycle = detectCycle(nodes);

    const errors = [...depValidation.errors];
    if (cycle) {
      errors.push(`Dependency cycle detected: ${cycle.join(" → ")}`);
    }

    return { valid: errors.length === 0, errors };
  }

  /** Dispatch-ready plan ids. `completedIds` lets a second execution wave run
   *  tasks whose dependencies finished since the first (Phase 3 multi-wave goals);
   *  default keeps Phase 2 behavior for existing callers/tests. */
  delegate(goalId: string, agents: AgentCandidate[], completedIds: ReadonlySet<string> = new Set()): CEODelegationResult {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return { success: false, goalId: null, taskIds: [], assignments: [], errors: [`Goal ${goalId} not found`], blockedTasks: [] };
    }

    const validation = this.validatePlan(goalId);
    if (!validation.valid) {
      return { success: false, goalId, taskIds: [], assignments: [], errors: validation.errors, blockedTasks: [] };
    }

    const plans = goal.taskIds
      .map((id) => this.taskPlans.get(id))
      .filter((p): p is TaskPlan => p !== undefined);

    const nodes: DependencyNode[] = plans.map((p) => ({
      id: p.id,
      dependencies: p.dependencies,
    }));

    const readyIds = getReadyTasks(nodes, completedIds);
    const blockedIds = getBlockedTasks(nodes, completedIds);

    const assignments: Array<{ taskId: string; agentId: string; agentName: string }> = [];
    const errors: string[] = [];

    const availableAgents = [...agents];

    for (const taskId of readyIds) {
      const plan = this.taskPlans.get(taskId);
      if (!plan) continue;

      const selection = selectAgentForTask(availableAgents, plan.requirements);

      if (selection.selected) {
        assignments.push({ taskId, agentId: selection.selected.id, agentName: selection.selected.name });
        availableAgents.splice(availableAgents.findIndex((a) => a.id === selection.selected!.id), 1);
      } else {
        errors.push(`No agent available for task "${plan.title}": ${selection.reason}`);
      }
    }

    goal.status = "ACTIVE";
    goal.updatedAt = new Date().toISOString();

    return {
      success: errors.length === 0,
      goalId,
      taskIds: readyIds,
      assignments,
      errors,
      blockedTasks: blockedIds,
    };
  }

  getGoal(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  /** Restore persisted state after a restart. Extra record fields (plans,
   *  runtime tasks) ride along structurally; only Goal/TaskPlan shapes are read. */
  hydrate(goals: Goal[], plans: TaskPlan[]): void {
    for (const goal of goals) {
      this.goals.set(goal.id, { ...goal, taskIds: [...goal.taskIds] });
    }
    for (const plan of plans) {
      this.taskPlans.set(plan.id, { ...plan });
    }
  }

  getTaskPlan(id: string): TaskPlan | undefined {
    return this.taskPlans.get(id);
  }

  getReadyTasks(goalId: string): string[] {
    const goal = this.goals.get(goalId);
    if (!goal) return [];

    const plans = goal.taskIds
      .map((id) => this.taskPlans.get(id))
      .filter((p): p is TaskPlan => p !== undefined);

    const nodes: DependencyNode[] = plans.map((p) => ({
      id: p.id,
      dependencies: p.dependencies,
    }));

    return getReadyTasks(nodes, new Set());
  }
}
