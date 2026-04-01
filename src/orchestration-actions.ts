import { writeTask, type Task } from "./tasks.js";
import { createThread, openTaskThread, type OrchestrationThread, updateThread } from "./threads.js";
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
