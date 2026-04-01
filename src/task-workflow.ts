import { type Task, writeTask } from "./tasks.js";
import { loadTeamConfig } from "./team.js";
import { openTaskThread, updateThread } from "./threads.js";
import { sendThreadMessage } from "./orchestration.js";
import type { TaskEvent } from "./task-dispatcher.js";

interface DispatchSession {
  id: string;
  write(data: string): void;
}

export class TaskWorkflow {
  injectIntoSession(session: DispatchSession, task: Task): TaskEvent {
    const thread = openTaskThread(task.id, {
      title: `${task.type === "review" ? "Review" : "Task"}: ${task.description}`,
      createdBy: task.assignedBy,
      participants: [task.assignedBy, session.id],
      kind: task.type === "review" ? "review" : "task",
    });
    task.threadId = thread.id;
    sendThreadMessage({
      threadId: thread.id,
      from: task.assignedBy,
      to: [session.id],
      kind: "request",
      body: task.description,
      metadata: { taskId: task.id },
    });

    const prefix =
      task.type === "review"
        ? `[AIMUX REVIEW ${task.id} from ${task.assignedBy}]`
        : `[AIMUX TASK ${task.id} from ${task.assignedBy}]`;

    let prompt = `${prefix} ${task.description}\n\n`;

    if (task.type === "review" && task.diff) {
      prompt += `Diff to review:\n${task.diff.slice(0, 3000)}\n\n`;
    }

    prompt +=
      `Read .aimux/tasks/${task.id}.json for full details. When done, update that file: ` +
      `set status to "done" and add a "result" field.`;

    if (task.type === "review") {
      prompt += ` Also set "reviewStatus" to "approved" or "changes_requested", and optionally add "reviewFeedback".`;
    } else {
      prompt += ` If you can't complete it, set status to "failed" with an "error" field.`;
    }

    session.write(prompt + "\r");
    task.status = "assigned";
    task.assignedTo = session.id;
    writeTask(task);
    return {
      type: "assigned",
      taskId: task.id,
      sessionId: session.id,
      description: task.description,
    };
  }

  notifyAssigner(session: DispatchSession, task: Task): void {
    if (task.threadId) {
      sendThreadMessage({
        threadId: task.threadId,
        from: task.assignedTo ?? task.assignedBy,
        to: [task.assignedBy],
        kind: task.status === "done" ? "status" : "reply",
        body:
          task.status === "done"
            ? `Completed: ${task.description}${task.result ? `\n\n${task.result}` : ""}`
            : `Failed: ${task.description}${task.error ? `\n\n${task.error}` : ""}`,
        metadata: { taskId: task.id, status: task.status },
      });
      updateThread(task.threadId, (current) => ({
        ...current,
        status: task.status === "done" ? "done" : "blocked",
        owner: task.assignedBy,
        waitingOn: [],
      }));
    }

    session.write(
      `[AIMUX TASK COMPLETE ${task.id}] Agent ${task.assignedTo} finished: ${task.result ?? task.error ?? "no details"}\r`,
    );
    task.notifiedAt = new Date().toISOString();
    writeTask(task);
  }

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
    if (reviewTask.reviewStatus === "approved") {
      return [
        {
          type: "review_approved",
          taskId: reviewTask.id,
          sessionId: reviewTask.assignedTo ?? "",
          description: reviewTask.description,
        },
      ];
    }

    if (reviewTask.reviewStatus !== "changes_requested") {
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
        `Changes requested by reviewer:\n\n${reviewTask.reviewFeedback ?? "(no feedback)"}\n\n` +
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
