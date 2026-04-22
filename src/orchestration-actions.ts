import { normalizeReviewStatus, readTask, writeTask, type Task } from "./tasks.js";
import {
  appendMessage,
  createThread,
  openTaskThread,
  readThread,
  type OrchestrationMessage,
  type OrchestrationThread,
  updateThread,
} from "./threads.js";
import { sendThreadMessage, type SendMessageResult } from "./orchestration.js";
import { TaskWorkflow } from "./task-workflow.js";

export interface AssignTaskInput {
  from: string;
  to?: string;
  assignee?: string;
  tool?: string;
  description: string;
  prompt?: string;
  type?: "task" | "review";
  diff?: string;
  worktreePath?: string;
}

export interface AssignTaskResult {
  task: Task;
  thread?: OrchestrationThread;
}

export interface HandoffLifecycleResult {
  thread: OrchestrationThread;
  message: OrchestrationMessage;
}

export interface TaskLifecycleResult {
  task: Task;
  thread?: OrchestrationThread;
  message?: OrchestrationMessage;
  followUpTask?: Task;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

export async function assignTask(input: AssignTaskInput): Promise<AssignTaskResult> {
  if (!input.to && !input.assignee && !input.tool) {
    throw new Error("task assignment requires --to, --assignee, or --tool");
  }
  const now = new Date().toISOString();
  const task: Task = {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    status: "pending",
    assignedBy: input.from,
    assignedTo: input.to,
    assignee: input.assignee,
    tool: input.tool,
    assigner: undefined,
    description: input.description,
    prompt: input.prompt?.trim() || input.description,
    createdAt: now,
    updatedAt: now,
    type: input.type ?? "task",
    diff: input.diff,
  };

  let thread: OrchestrationThread | undefined;
  const participants = unique([input.from, input.to]);
  if (input.to) {
    thread = openTaskThread(task.id, {
      title: `${task.type === "review" ? "Review" : "Task"}: ${task.description}`,
      createdBy: input.from,
      participants,
      worktreePath: input.worktreePath,
      kind: task.type === "review" ? "review" : "task",
    });
    task.threadId = thread.id;
    thread =
      updateThread(thread.id, (current) => ({
        ...current,
        status: "waiting",
        owner: input.to ?? current.owner ?? input.from,
        waitingOn: input.to ? [input.to] : current.waitingOn,
      })) ?? thread;
    task.threadId = thread.id;
  } else {
    thread = createThread({
      title: `${task.type === "review" ? "Review" : "Task"}: ${task.description}`,
      kind: task.type === "review" ? "review" : "task",
      createdBy: input.from,
      participants: [input.from],
      taskId: task.id,
      worktreePath: input.worktreePath,
      owner: input.from,
      waitingOn: [],
      status: "open",
    });
    task.threadId = thread.id;
  }

  await writeTask(task);
  return { task, thread };
}

export function sendHandoff(input: {
  from: string;
  to: string[];
  body: string;
  title?: string;
  worktreePath?: string;
}): SendMessageResult {
  const recipients = unique(input.to);
  if (recipients.length === 0) {
    throw new Error("handoff requires at least one recipient");
  }
  const thread = createThread({
    title: input.title?.trim() || `Handoff: ${input.from} → ${recipients.join(", ")}`,
    kind: "handoff",
    createdBy: input.from,
    participants: unique([input.from, ...recipients]),
    worktreePath: input.worktreePath,
    tags: ["handoff"],
    owner: input.from,
    waitingOn: recipients,
    status: "waiting",
  });
  return sendThreadMessage({
    threadId: thread.id,
    from: input.from,
    to: recipients,
    kind: "handoff",
    body: input.body,
  });
}

function uniqueParticipants(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

export function acceptHandoff(input: { threadId: string; from: string; body?: string }): HandoffLifecycleResult {
  const thread = readThread(input.threadId);
  if (!thread) throw new Error(`thread not found: ${input.threadId}`);
  if (thread.kind !== "handoff") throw new Error(`thread ${input.threadId} is not a handoff`);
  const actor = input.from.trim();
  const recipients = uniqueParticipants([thread.createdBy === actor ? undefined : thread.createdBy]);
  const body = input.body?.trim() || "Accepted handoff.";
  const message = appendMessage(thread.id, {
    from: actor,
    to: recipients,
    kind: "decision",
    body,
    metadata: { handoffAction: "accepted" },
  });
  const updated = updateThread(thread.id, (current) => ({
    ...current,
    participants: uniqueParticipants([...current.participants, actor, ...recipients]),
    owner: actor,
    waitingOn: [],
    status: "open",
  }));
  if (!updated) throw new Error(`thread disappeared after update: ${thread.id}`);
  return { thread: updated, message };
}

export function completeHandoff(input: { threadId: string; from: string; body?: string }): HandoffLifecycleResult {
  const thread = readThread(input.threadId);
  if (!thread) throw new Error(`thread not found: ${input.threadId}`);
  if (thread.kind !== "handoff") throw new Error(`thread ${input.threadId} is not a handoff`);
  const actor = input.from.trim();
  const recipients = uniqueParticipants([thread.createdBy === actor ? undefined : thread.createdBy]);
  const body = input.body?.trim() || "Completed handoff.";
  const message = appendMessage(thread.id, {
    from: actor,
    to: recipients,
    kind: "decision",
    body,
    metadata: { handoffAction: "completed" },
  });
  const updated = updateThread(thread.id, (current) => ({
    ...current,
    participants: uniqueParticipants([...current.participants, actor, ...recipients]),
    owner: actor,
    waitingOn: recipients,
    status: recipients.length > 0 ? "waiting" : "done",
  }));
  if (!updated) throw new Error(`thread disappeared after update: ${thread.id}`);
  return { thread: updated, message };
}

function requireTask(taskId: string): Task {
  const task = readTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return task;
}

async function createReworkTaskFromReview(reviewTask: Task): Promise<Task | undefined> {
  if (normalizeReviewStatus(reviewTask.reviewStatus) !== "changes_requested") return undefined;
  const iteration = (reviewTask.iteration ?? 1) + 1;
  if (iteration > 5) return undefined;
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
  await writeTask(followUp);
  return followUp;
}

function updateTaskThread(
  task: Task,
  input: {
    from: string;
    body: string;
    action: "accepted" | "blocked" | "completed";
    kind: "decision" | "reply" | "status";
  },
  transform: (thread: OrchestrationThread) => OrchestrationThread,
): { thread?: OrchestrationThread; message?: OrchestrationMessage } {
  if (!task.threadId) return {};
  const thread = readThread(task.threadId);
  if (!thread) return {};
  const actor = input.from.trim();
  const recipients = uniqueParticipants([thread.createdBy === actor ? undefined : thread.createdBy]);
  const message = appendMessage(thread.id, {
    from: actor,
    to: recipients,
    kind: input.kind,
    body: input.body,
    metadata: { taskId: task.id, taskAction: input.action },
  });
  const updated = updateThread(thread.id, (current) =>
    transform({
      ...current,
      participants: uniqueParticipants([...current.participants, actor, ...recipients]),
    }),
  );
  return { thread: updated ?? thread, message };
}

export async function acceptTask(input: { taskId: string; from: string; body?: string }): Promise<TaskLifecycleResult> {
  const task = requireTask(input.taskId);
  task.status = "in_progress";
  task.assignedTo = input.from.trim() || task.assignedTo;
  const body = input.body?.trim() || "Accepted task and started work.";
  const threadResult = updateTaskThread(
    task,
    { from: input.from, body, action: "accepted", kind: "decision" },
    (current) => ({
      ...current,
      owner: input.from.trim() || current.owner,
      waitingOn: [],
      status: "open",
    }),
  );
  await writeTask(task);
  return { task, ...threadResult };
}

export async function blockTask(input: { taskId: string; from: string; body?: string }): Promise<TaskLifecycleResult> {
  const task = requireTask(input.taskId);
  task.status = "blocked";
  task.assignedTo = input.from.trim() || task.assignedTo;
  task.error = input.body?.trim() || task.error || "Task is blocked.";
  const threadResult = updateTaskThread(
    task,
    { from: input.from, body: task.error, action: "blocked", kind: "reply" },
    (current) => ({
      ...current,
      owner: input.from.trim() || current.owner,
      waitingOn: [task.assignedBy],
      status: "blocked",
    }),
  );
  await writeTask(task);
  return { task, ...threadResult };
}

export async function completeTask(input: {
  taskId: string;
  from: string;
  body?: string;
}): Promise<TaskLifecycleResult> {
  const task = requireTask(input.taskId);
  task.status = "done";
  task.assignedTo = input.from.trim() || task.assignedTo;
  if (input.body?.trim()) task.result = input.body.trim();
  task.notifiedAt = new Date().toISOString();
  const threadResult = updateTaskThread(
    task,
    { from: input.from, body: task.result?.trim() || "Completed task.", action: "completed", kind: "status" },
    (current) => ({
      ...current,
      owner: input.from.trim() || current.owner,
      waitingOn: [task.assignedBy],
      status: "waiting",
    }),
  );
  await writeTask(task);
  new TaskWorkflow().handleCompletion(task);
  return { task, ...threadResult };
}

export async function approveReview(input: {
  taskId: string;
  from: string;
  body?: string;
}): Promise<TaskLifecycleResult> {
  const task = requireTask(input.taskId);
  if (task.type !== "review") throw new Error(`task ${input.taskId} is not a review`);
  task.status = "done";
  task.assignedTo = input.from.trim() || task.assignedTo;
  task.reviewStatus = "approved";
  if (input.body?.trim()) task.reviewFeedback = input.body.trim();
  task.notifiedAt = new Date().toISOString();
  const body = input.body?.trim() || "Approved review.";
  const threadResult = updateTaskThread(
    task,
    { from: input.from, body, action: "completed", kind: "decision" },
    (current) => ({
      ...current,
      owner: input.from.trim() || current.owner,
      waitingOn: [task.assignedBy],
      status: "waiting",
    }),
  );
  await writeTask(task);
  return { task, ...threadResult };
}

export async function requestTaskChanges(input: {
  taskId: string;
  from: string;
  body?: string;
}): Promise<TaskLifecycleResult> {
  const task = requireTask(input.taskId);
  if (task.type !== "review") throw new Error(`task ${input.taskId} is not a review`);
  task.status = "done";
  task.assignedTo = input.from.trim() || task.assignedTo;
  task.reviewStatus = "changes_requested";
  task.reviewFeedback = input.body?.trim() || "Changes requested.";
  task.notifiedAt = new Date().toISOString();
  const threadResult = updateTaskThread(
    task,
    { from: input.from, body: task.reviewFeedback, action: "blocked", kind: "reply" },
    (current) => ({
      ...current,
      owner: input.from.trim() || current.owner,
      waitingOn: [task.assignedBy],
      status: "blocked",
    }),
  );
  await writeTask(task);
  const followUpTask = await createReworkTaskFromReview(task);
  return { task, ...threadResult, followUpTask };
}

export async function reopenTask(input: { taskId: string; from: string; body?: string }): Promise<TaskLifecycleResult> {
  const task = requireTask(input.taskId);
  const now = new Date().toISOString();
  const rootTaskId = task.reviewOf ?? task.id;
  const iteration = (task.iteration ?? 1) + 1;
  const reopened: Task = {
    id: `reopen-${rootTaskId}-${Date.now().toString(36)}`,
    status: "pending",
    assignedBy: input.from.trim() || "user",
    description:
      task.type === "review"
        ? `Revision ${iteration}: ${task.description.replace(/^Review: /, "")}`
        : `Reopen: ${task.description.replace(/^Revision \d+: /, "")}`,
    prompt:
      input.body?.trim() ||
      task.reviewFeedback ||
      task.result ||
      task.error ||
      `Reopened from ${task.id}. Continue the workflow from the latest context.`,
    createdAt: now,
    updatedAt: now,
    assignee: task.type === "review" ? (task.assigner ?? "coder") : task.assignee,
    assigner: task.type === "review" ? task.assignee : task.assigner,
    tool: task.tool,
    type: "task",
    iteration,
    reviewOf: rootTaskId,
  };
  await writeTask(reopened);
  return { task: reopened };
}
