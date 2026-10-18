import type { HiveManager, HiveTask, AgentMeta } from "./hive";
import { CEOOrchestrator, type CEODelegationResult, type TaskPlan } from "./ceo";
import { TaskState } from "../shared/taskStateMachine";
import { randomUUID } from "node:crypto";

export interface CEOLiveConfig {
  godId: string;
  persistTasks: boolean;
  deliverToInbox: boolean;
}

export interface CEOLiveResult {
  goalId: string;
  tasksCreated: number;
  tasksDelivered: number;
  assignments: Array<{ taskId: string; agentId: string; agentName: string }>;
  errors: string[];
}

export class CEOLiveIntegration {
  private orchestrator: CEOOrchestrator;
  private hive: HiveManager;
  private config: CEOLiveConfig;

  constructor(hive: HiveManager, config: CEOLiveConfig) {
    this.hive = hive;
    this.config = config;
    this.orchestrator = new CEOOrchestrator();
  }

  createGoal(title: string, description: string, createdBy: string) {
    return this.orchestrator.createGoal({ title, description, createdBy });
  }

  addTaskPlan(goalId: string, plan: TaskPlan) {
    return this.orchestrator.addTaskPlan(goalId, plan);
  }

  executeGoal(goalId: string): CEOLiveResult {
    const goal = this.orchestrator.getGoal(goalId);
    if (!goal) {
      return { goalId, tasksCreated: 0, tasksDelivered: 0, assignments: [], errors: [`Goal ${goalId} not found`] };
    }

    const registry = this.hive.registry();
    const agents: Array<{ id: string; name: string; role: string; skills: string[]; tools: string[]; status: string; currentTaskId: string | null; permissions: string[] }> = [];

    for (const [id, meta] of Object.entries(registry.agents)) {
      if (meta.archived) continue;
      agents.push({
        id,
        name: meta.name,
        role: meta.role ?? "agent",
        skills: meta.capabilities ?? [],
        tools: [],
        status: meta.status,
        currentTaskId: null,
        permissions: [],
      });
    }

    const result = this.orchestrator.delegate(goalId, agents);

    if (!result.success) {
      return {
        goalId,
        tasksCreated: 0,
        tasksDelivered: 0,
        assignments: [],
        errors: result.errors,
      };
    }

    let tasksCreated = 0;
    let tasksDelivered = 0;

    for (const taskId of result.taskIds) {
      const plan = this.orchestrator.getTaskPlan(taskId);
      if (!plan) continue;

      const assignment = result.assignments.find((a) => a.taskId === taskId);

      if (this.config.persistTasks) {
        const hiveTask: HiveTask = {
          id: taskId,
          title: plan.title,
          description: plan.description,
          assignee: assignment?.agentId,
          status: "todo",
          dependsOn: plan.dependencies,
          priority: 2,
          createdAt: new Date().toISOString(),
        };
        this.hive.addTask(hiveTask);
        tasksCreated++;
      }

      if (this.config.deliverToInbox && assignment) {
        this.hive.send({
          from: this.config.godId,
          to: assignment.agentId,
          act: "request",
          subject: `Task: ${plan.title}`,
          body: this.formatTaskBrief(plan, goal.title),
          requires_reply: true,
          conversation: goalId,
        });
        tasksDelivered++;
      }
    }

    return {
      goalId,
      tasksCreated,
      tasksDelivered,
      assignments: result.assignments,
      errors: [],
    };
  }

  updateTaskStatus(taskId: string, status: HiveTask["status"]): boolean {
    return this.hive.patchTask(taskId, { status });
  }

  getGoalTasks(goalId: string): HiveTask[] {
    const ledger = this.hive.tasks() as { tasks?: HiveTask[] } | null;
    if (!ledger?.tasks) return [];
    return ledger.tasks.filter((t) => t.id && this.orchestrator.getTaskPlan(t.id));
  }

  private formatTaskBrief(plan: TaskPlan, goalTitle: string): string {
    const lines = [
      `Goal: ${goalTitle}`,
      ``,
      `Objective: ${plan.description}`,
      ``,
      `Acceptance criteria:`,
      ...plan.acceptanceCriteria.map((c) => `- ${c}`),
    ];

    if (plan.dependencies.length > 0) {
      lines.push(``, `Depends on: ${plan.dependencies.join(", ")}`);
    }

    if (plan.requiresApproval) {
      lines.push(``, `This task requires approval before external actions.`);
    }

    lines.push(``, `Reply with "done" when complete, or "blocked" with a reason if you cannot proceed.`);

    return lines.join("\n");
  }
}
