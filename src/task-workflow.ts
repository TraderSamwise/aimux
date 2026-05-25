import { normalizeReviewStatus, type Task, writeTask } from "./tasks.js";
import { loadTeamConfig } from "./team.js";

export interface TaskEvent {
  type: "assigned" | "completed" | "failed" | "review_created" | "review_approved" | "changes_requested";
  taskId: string;
  sessionId: string;
  description: string;
}

export class TaskWorkflow {
  handleCompletion(task: Task): TaskEvent[] {
    if (task.type === "review") {
      return this.handleReviewCompletion(task);
    }

    const assignerRole = task.assigner;
    if (!assignerRole) return [];

    const config = loadTeamConfig();
    const roleConfig = config.roles[assignerRole];
    if (!roleConfig?.reviewedBy) return [];

    const reviewerRole = roleConfig.reviewedBy;

    const reviewTask: Task = {
      id: `review-${task.id}-${Date.now().toString(36)}`,
      status: "pending",
      assignedBy: task.assignedTo ?? task.assignedBy,
      description: `Review: ${task.description}`,
      prompt: `Review the changes from task "${task.description}".\n\nResult: ${task.result ?? "(no result)"}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignee: reviewerRole,
      assigner: task.assignee,
      type: "review",
      reviewStatus: "pending",
      diff: task.diff,
      iteration: 1,
      reviewOf: task.id,
    };

    writeTask(reviewTask);
    return [
      {
        type: "review_created",
        taskId: reviewTask.id,
        sessionId: "",
        description: reviewTask.description,
      },
    ];
  }

  private handleReviewCompletion(reviewTask: Task): TaskEvent[] {
    const reviewStatus = normalizeReviewStatus(reviewTask.reviewStatus);
    if (reviewStatus === "approved") {
      return [
        {
          type: "review_approved",
          taskId: reviewTask.id,
          sessionId: reviewTask.assignedTo ?? "",
          description: reviewTask.description,
        },
      ];
    }

    if (reviewStatus !== "changes_requested") {
      return [];
    }

    const iteration = (reviewTask.iteration ?? 1) + 1;
    if (iteration > 5) return [];

    const followUp: Task = {
      id: `revision-${reviewTask.reviewOf ?? "unknown"}-${Date.now().toString(36)}`,
      status: "pending",
      assignedBy: reviewTask.assignedTo ?? reviewTask.assignedBy,
      description: `Revision ${iteration}: ${reviewTask.description.replace(/^Review: /, "")}`,
      prompt:
        `Changes requested by reviewer:\n\n${reviewTask.reviewFeedback ?? reviewTask.result ?? "(no feedback)"}\n\n` +
        `Original task: ${reviewTask.description}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignee: reviewTask.assigner ?? "coder",
      assigner: reviewTask.assignee,
      type: "task",
      iteration,
      reviewOf: reviewTask.reviewOf,
    };

    writeTask(followUp);
    return [
      {
        type: "changes_requested",
        taskId: followUp.id,
        sessionId: "",
        description: followUp.description,
      },
    ];
  }
}

export async function requestReview(
  agentSessionId: string,
  agentRole: string,
  diff: string | undefined,
  summary: string,
): Promise<Task | null> {
  const config = loadTeamConfig();
  const roleConfig = config.roles[agentRole];
  let reviewerRole = roleConfig?.reviewedBy;

  if (!reviewerRole) {
    const roles = Object.entries(config.roles).filter(([roleKey]) => roleKey !== agentRole);
    const fallback =
      roles.find(([, role]) => role.description.toLowerCase().includes("review")) ??
      roles.find(([, role]) => role.canEdit);
    if (!fallback) return null;
    reviewerRole = fallback[0];
  }

  if (reviewerRole === agentRole) {
    const roles = Object.entries(config.roles).filter(([roleKey]) => roleKey !== agentRole);
    const fallback =
      roles.find(([, role]) => role.description.toLowerCase().includes("review")) ??
      roles.find(([, role]) => role.canEdit);
    if (!fallback) return null;
    reviewerRole = fallback[0];
  }

  const reviewTask: Task = {
    id: `review-manual-${Date.now().toString(36)}`,
    status: "pending",
    assignedBy: agentSessionId,
    description: `Review: ${summary.slice(0, 100)}`,
    prompt: summary,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignee: reviewerRole,
    assigner: agentRole,
    type: "review",
    reviewStatus: "pending",
    diff,
    iteration: 1,
  };

  await writeTask(reviewTask);
  return reviewTask;
}
