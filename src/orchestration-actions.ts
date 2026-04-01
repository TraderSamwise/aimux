import { writeTask, type Task } from "./tasks.js";
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
