export const GoalStatus = {
  DRAFT: "DRAFT",
  PLANNED: "PLANNED",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;

export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  taskIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateGoalInput {
  title: string;
  description: string;
  createdBy: string;
}
