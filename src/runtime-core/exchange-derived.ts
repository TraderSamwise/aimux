import type {
  RuntimeExchange,
  RuntimeExchangeHandoff,
  RuntimeExchangeInboxEntry,
  RuntimeExchangeMessage,
  RuntimeExchangeReview,
  RuntimeExchangeTask,
  RuntimeExchangeThread,
  RuntimeExchangeWait,
} from "./exchange-store.js";

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function handoffActionFromMessages(messages: RuntimeExchangeMessage[]): {
  action?: "accepted" | "completed";
  actor?: string;
} {
  const lifecycleMessage = [...messages]
    .reverse()
    .find(
      (message) => message.metadata?.handoffAction === "accepted" || message.metadata?.handoffAction === "completed",
    );
  return {
    action: lifecycleMessage?.metadata?.handoffAction as "accepted" | "completed" | undefined,
    actor: lifecycleMessage?.from,
  };
}

function handoffFromThread(
  thread: RuntimeExchangeThread,
  messages: RuntimeExchangeMessage[],
): RuntimeExchangeHandoff | undefined {
  if (thread.kind !== "handoff") return undefined;
  const recipients = unique(
    thread.waitingOn?.length ? thread.waitingOn : thread.participants.filter((id) => id !== thread.createdBy),
  );
  if (recipients.length === 0) return undefined;
  const lifecycle = handoffActionFromMessages(messages);
  const status =
    lifecycle.action === "completed"
      ? "completed"
      : lifecycle.action === "accepted"
        ? "accepted"
        : thread.status === "done"
          ? "completed"
          : thread.status === "abandoned"
            ? "cancelled"
            : "waiting";
  return {
    id: `handoff:${thread.id}`,
    threadId: thread.id,
    status,
    from: thread.createdBy,
    to: recipients,
    acceptedBy: lifecycle.action === "accepted" ? lifecycle.actor : thread.status === "open" ? thread.owner : undefined,
    completedBy:
      lifecycle.action === "completed" ? lifecycle.actor : thread.status === "done" ? thread.owner : undefined,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function reviewFromTask(task: RuntimeExchangeTask): RuntimeExchangeReview | undefined {
  if (task.type !== "review") return undefined;
  return {
    id: `review:${task.id}`,
    taskId: task.id,
    reviewOf: task.reviewOf,
    reviewer: task.assignedTo ?? task.assignee,
    status: task.reviewStatus ?? "pending",
    feedback: task.reviewFeedback ?? task.result,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function waitsFromThread(thread: RuntimeExchangeThread): RuntimeExchangeWait[] {
  const waitingOn = unique(thread.waitingOn ?? []);
  if (waitingOn.length === 0) return [];
  return [
    {
      id: `wait:thread:${thread.id}`,
      status: thread.status === "done" || thread.status === "abandoned" ? "satisfied" : "waiting",
      subjectKind: "thread",
      subjectId: thread.id,
      waitingOn,
      owner: thread.owner,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      resolvedAt: thread.status === "done" || thread.status === "abandoned" ? thread.updatedAt : undefined,
    },
  ];
}

function waitsFromTask(task: RuntimeExchangeTask): RuntimeExchangeWait[] {
  const waitingOn = unique([
    task.status === "blocked" ? task.assignedBy : undefined,
    task.status === "assigned" || task.status === "pending" || task.status === "in_progress"
      ? (task.assignedTo ?? task.assignee)
      : undefined,
  ]);
  if (waitingOn.length === 0) return [];
  return [
    {
      id: `wait:task:${task.id}`,
      status: task.status === "done" || task.status === "failed" ? "satisfied" : "waiting",
      subjectKind: "task",
      subjectId: task.id,
      waitingOn,
      owner: task.assignedBy,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      resolvedAt: task.status === "done" || task.status === "failed" ? task.updatedAt : undefined,
    },
  ];
}

function inboxFromThread(thread: RuntimeExchangeThread): RuntimeExchangeInboxEntry[] {
  const participants = unique([...(thread.unreadBy ?? []), ...(thread.waitingOn ?? [])]);
  return participants.map((participantId) => {
    const waiting = (thread.waitingOn ?? []).includes(participantId);
    return {
      id: `inbox:${participantId}:thread:${thread.id}`,
      participantId,
      subjectKind: "thread",
      subjectId: thread.id,
      state: thread.status === "blocked" ? "blocked" : waiting ? "waiting" : "unread",
      urgency: (waiting ? 10 : 0) + ((thread.unreadBy ?? []).includes(participantId) ? 3 : 0),
      updatedAt: thread.updatedAt,
    };
  });
}

function inboxFromTask(task: RuntimeExchangeTask): RuntimeExchangeInboxEntry[] {
  const participants = unique([
    task.status === "blocked" ? task.assignedBy : undefined,
    task.status !== "done" && task.status !== "failed" ? (task.assignedTo ?? task.assignee) : undefined,
  ]);
  return participants.map((participantId) => ({
    id: `inbox:${participantId}:task:${task.id}`,
    participantId,
    subjectKind: "task",
    subjectId: task.id,
    state: task.status === "blocked" ? "blocked" : task.status === "done" ? "done" : "waiting",
    urgency: task.status === "blocked" ? 12 : task.type === "review" ? 8 : 6,
    updatedAt: task.updatedAt,
  }));
}

function preserveAcknowledgedInbox(
  nextEntries: RuntimeExchangeInboxEntry[],
  previousEntries: RuntimeExchangeInboxEntry[],
): RuntimeExchangeInboxEntry[] {
  const previousById = new Map(previousEntries.map((entry) => [entry.id, entry] as const));
  return nextEntries.map((entry) => {
    const previous = previousById.get(entry.id);
    if (previous?.state === "done" && previous.updatedAt === entry.updatedAt) {
      return { ...entry, state: "done" };
    }
    return entry;
  });
}

export function deriveRuntimeExchangeIndexes(exchange: RuntimeExchange): RuntimeExchange {
  const messagesByThread = new Map<string, RuntimeExchangeMessage[]>();
  for (const message of exchange.messages) {
    const existing = messagesByThread.get(message.threadId) ?? [];
    existing.push(message);
    messagesByThread.set(message.threadId, existing);
  }
  const nextInbox = [...exchange.threads.flatMap(inboxFromThread), ...exchange.tasks.flatMap(inboxFromTask)];
  return {
    ...exchange,
    handoffs: exchange.threads
      .map((thread) => handoffFromThread(thread, messagesByThread.get(thread.id) ?? []))
      .filter((handoff): handoff is RuntimeExchangeHandoff => Boolean(handoff)),
    reviews: exchange.tasks.map(reviewFromTask).filter((review): review is RuntimeExchangeReview => Boolean(review)),
    waits: [...exchange.threads.flatMap(waitsFromThread), ...exchange.tasks.flatMap(waitsFromTask)],
    inbox: preserveAcknowledgedInbox(nextInbox, exchange.inbox),
  };
}
