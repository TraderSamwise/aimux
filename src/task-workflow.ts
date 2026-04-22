import { normalizeReviewStatus, type Task, writeTask } from "./tasks.js";
import { loadTeamConfig } from "./team.js";
import { markMessageDelivered, openTaskThread, updateThread } from "./threads.js";
import { sendThreadMessage } from "./orchestration.js";
import type { TaskEvent } from "./task-dispatcher.js";

interface DispatchSession {
  id: string;
  write(data: string): void;
}

export class TaskWorkflow {
  constructor(
    private readonly deliverPrompt: (session: DispatchSession, prompt: string) => void = defaultDeliverPrompt,
  ) {}

  injectIntoSession(session: DispatchSession, task: Task): TaskEvent {
    const thread = openTaskThread(task.id, {
      title: `${task.type === "review" ? "Review" : "Task"}: ${task.description}`,
      createdBy: task.assignedBy,
      participants: [task.assignedBy, session.id],
      kind: task.type === "review" ? "review" : "task",
    });
    task.threadId = thread.id;
    const initialMessage = sendThreadMessage({
      threadId: thread.id,
      from: task.assignedBy,
      to: [session.id],
      kind: "request",
      body: task.description,
      metadata: { taskId: task.id },
    });
    markMessageDelivered(thread.id, initialMessage.message.id, session.id);

    const prefix =
      task.type === "review"
        ? `[AIMUX REVIEW ${task.id} from ${task.assignedBy}]`
        : `[AIMUX TASK ${task.id} from ${task.assignedBy}]`;

    let prompt = `${prefix} ${task.description}\n\n`;

    if (task.type === "review" && task.diff) {
      prompt += `Diff to review:\n${task.diff.slice(0, 3000)}\n\n`;
    }

    prompt +=
      `Run:\n` +
      `  aimux task show ${task.id}\n` +
      `  aimux thread show ${thread.id}\n\n` +
      `Acknowledge with:\n` +
      `  aimux task accept ${task.id} --from ${session.id}\n\n` +
      `When done, complete with:\n` +
      `  aimux task complete ${task.id} --from ${session.id} --body "<summary>"`;

    if (task.type === "review") {
      prompt +=
        `\n\nFor review verdicts use:\n` +
        `  aimux review approve ${task.id} --from ${session.id} --body "<notes>"\n` +
        `  aimux review request-changes ${task.id} --from ${session.id} --body "<requested changes>"`;
    } else {
      prompt += `\n\nIf blocked, use:\n  aimux task block ${task.id} --from ${session.id} --body "<reason>"`;
    }

    this.deliverPrompt(session, prompt);
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

    this.deliverPrompt(
      session,
      `[AIMUX TASK COMPLETE ${task.id}] Agent ${task.assignedTo} finished: ${task.result ?? task.error ?? "no details"}`,
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

function defaultDeliverPrompt(session: DispatchSession, prompt: string): void {
  session.write(prompt + "\r");
}
