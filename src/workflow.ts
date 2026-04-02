import { readAllTasks, type Task } from "./tasks.js";
import { listThreadSummaries, readMessages, type ThreadSummary } from "./threads.js";

export interface ThreadEntry extends ThreadSummary {
  displayTitle: string;
  pendingDeliveries: number;
  latestPendingRecipients: string[];
}

export interface WorkflowEntry extends ThreadEntry {
  task?: Task;
  urgency: number;
  stateLabel: string;
  familyRootTaskId?: string;
  familyTaskIds: string[];
}

export type WorkflowFilter = "all" | "on_me" | "blocked" | "families";

export function buildThreadEntries(): ThreadEntry[] {
  return listThreadSummaries()
    .map((summary) => {
      const messages = readMessages(summary.thread.id);
      const pending = messages.flatMap((message) =>
        (message.to ?? []).filter((recipient) => !(message.deliveredTo ?? []).includes(recipient)),
      );
      const latestWithPending = [...messages]
        .reverse()
        .find((message) => (message.to ?? []).some((recipient) => !(message.deliveredTo ?? []).includes(recipient)));
      const latestPendingRecipients = (latestWithPending?.to ?? []).filter(
        (recipient) => !(latestWithPending?.deliveredTo ?? []).includes(recipient),
      );
      return {
        ...summary,
        displayTitle: summary.thread.title || `${summary.thread.kind} ${summary.thread.id}`,
        pendingDeliveries: pending.length,
        latestPendingRecipients,
      };
    })
    .sort((a, b) => (a.thread.updatedAt < b.thread.updatedAt ? 1 : a.thread.updatedAt > b.thread.updatedAt ? -1 : 0));
}

export function buildWorkflowEntries(currentParticipant = "user"): WorkflowEntry[] {
  const tasks = readAllTasks();
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const familyByRoot = new Map<string, Task[]>();
  for (const task of tasks) {
    const root = task.reviewOf ?? task.id;
    const existing = familyByRoot.get(root) ?? [];
    existing.push(task);
    familyByRoot.set(root, existing);
  }
  for (const family of familyByRoot.values()) {
    family.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
  return buildThreadEntries()
    .filter(
      (entry) => entry.thread.kind === "task" || entry.thread.kind === "review" || entry.thread.kind === "handoff",
    )
    .map((entry) => {
      const task = entry.thread.taskId ? taskById.get(entry.thread.taskId) : undefined;
      const waitingOnMe = (entry.thread.waitingOn ?? []).includes(currentParticipant) ? 1 : 0;
      const unread = (entry.thread.unreadBy ?? []).includes(currentParticipant) ? 1 : 0;
      const blocked = entry.thread.status === "blocked" ? 1 : 0;
      const pending = entry.pendingDeliveries;
      const taskAssigned =
        task && (task.status === "assigned" || task.status === "in_progress" || task.status === "blocked") ? 1 : 0;
      const urgency = waitingOnMe * 10 + blocked * 8 + pending * 4 + unread * 3 + taskAssigned * 2;
      const stateLabel =
        entry.thread.status === "blocked"
          ? "blocked"
          : waitingOnMe
            ? "on me"
            : (entry.thread.waitingOn?.length ?? 0) > 0
              ? `on ${entry.thread.waitingOn!.join(", ")}`
              : (task?.status ?? entry.thread.status);
      const familyRootTaskId = task ? (task.reviewOf ?? task.id) : undefined;
      const familyTaskIds = familyRootTaskId
        ? (familyByRoot.get(familyRootTaskId) ?? [task!]).map((item) => item.id)
        : [];
      return {
        ...entry,
        task,
        urgency,
        stateLabel,
        familyRootTaskId,
        familyTaskIds,
      };
    })
    .sort((a, b) => b.urgency - a.urgency || (a.thread.updatedAt < b.thread.updatedAt ? 1 : -1));
}

export function filterWorkflowEntries(
  entries: WorkflowEntry[],
  filter: WorkflowFilter,
  currentParticipant = "user",
): WorkflowEntry[] {
  if (filter === "all") return entries;
  if (filter === "on_me") {
    return entries.filter((entry) => (entry.thread.waitingOn ?? []).includes(currentParticipant));
  }
  if (filter === "blocked") {
    return entries.filter((entry) => entry.thread.status === "blocked" || entry.task?.status === "blocked");
  }
  return entries.filter((entry) => entry.familyTaskIds.length > 1);
}
