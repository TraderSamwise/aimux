import type {
  RuntimeExchange,
  RuntimeExchangeAttachmentRef,
  RuntimeExchangeInboxEntry,
  RuntimeExchangeMessage,
  RuntimeExchangeTask,
  RuntimeExchangeThread,
  RuntimeExchangeWait,
} from "./exchange-store.js";

export const RUNTIME_EXCHANGE_RETENTION = {
  notificationThreads: 500,
  closedWorkflowThreads: 300,
  closedTasks: 500,
  activeThreadMessages: 300,
  closedThreadMessages: 50,
  notificationThreadMessages: 1,
} as const;

export interface RuntimeExchangeCounts {
  threads: number;
  messages: number;
  tasks: number;
  handoffs: number;
  reviews: number;
  waits: number;
  inbox: number;
  planRefs: number;
  continuityRefs: number;
  attachmentRefs: number;
  totalRecords: number;
}

export interface RuntimeExchangeCompactionReport {
  retained: RuntimeExchange;
  before: RuntimeExchangeCounts;
  after: RuntimeExchangeCounts;
  removed: RuntimeExchangeCounts;
  retention: typeof RUNTIME_EXCHANGE_RETENTION;
  changed: boolean;
}

export function countRuntimeExchangeRecords(exchange: RuntimeExchange): RuntimeExchangeCounts {
  const counts = {
    threads: exchange.threads.length,
    messages: exchange.messages.length,
    tasks: exchange.tasks.length,
    handoffs: exchange.handoffs.length,
    reviews: exchange.reviews.length,
    waits: exchange.waits.length,
    inbox: exchange.inbox.length,
    planRefs: exchange.planRefs.length,
    continuityRefs: exchange.continuityRefs.length,
    attachmentRefs: exchange.attachmentRefs.length,
  };
  return {
    ...counts,
    totalRecords: Object.values(counts).reduce((sum, value) => sum + value, 0),
  };
}

function subtractCounts(before: RuntimeExchangeCounts, after: RuntimeExchangeCounts): RuntimeExchangeCounts {
  return {
    threads: before.threads - after.threads,
    messages: before.messages - after.messages,
    tasks: before.tasks - after.tasks,
    handoffs: before.handoffs - after.handoffs,
    reviews: before.reviews - after.reviews,
    waits: before.waits - after.waits,
    inbox: before.inbox - after.inbox,
    planRefs: before.planRefs - after.planRefs,
    continuityRefs: before.continuityRefs - after.continuityRefs,
    attachmentRefs: before.attachmentRefs - after.attachmentRefs,
    totalRecords: before.totalRecords - after.totalRecords,
  };
}

function byUpdatedAtDesc<T extends { updatedAt?: string; createdAt?: string; ts?: string }>(a: T, b: T): number {
  const left = a.updatedAt ?? a.ts ?? a.createdAt ?? "";
  const right = b.updatedAt ?? b.ts ?? b.createdAt ?? "";
  return right.localeCompare(left);
}

function isNotificationThread(thread: RuntimeExchangeThread): boolean {
  return thread.tags?.includes("notification") === true;
}

function isClosedThread(thread: RuntimeExchangeThread): boolean {
  return thread.status === "done" || thread.status === "abandoned";
}

function isActiveThread(thread: RuntimeExchangeThread, activeTaskIds: Set<string>): boolean {
  if (!isClosedThread(thread)) return true;
  if ((thread.waitingOn ?? []).length > 0 || (thread.unreadBy ?? []).length > 0) return true;
  return Boolean(thread.taskId && activeTaskIds.has(thread.taskId));
}

function isActiveTask(task: RuntimeExchangeTask): boolean {
  return task.status !== "done" && task.status !== "failed";
}

function groupMessagesByThreadId(messages: RuntimeExchangeMessage[]): Map<string, RuntimeExchangeMessage[]> {
  const grouped = new Map<string, RuntimeExchangeMessage[]>();
  for (const message of messages) {
    const existing = grouped.get(message.threadId) ?? [];
    existing.push(message);
    grouped.set(message.threadId, existing);
  }
  return grouped;
}

function latestRetainedMessageId(messages: RuntimeExchangeMessage[]): string | undefined {
  return [...messages].sort((a, b) => byUpdatedAtDesc(a, b))[0]?.id;
}

function selectLatestIds<T extends { id: string; updatedAt?: string; createdAt?: string; ts?: string }>(
  records: T[],
  limit: number,
): Set<string> {
  return new Set(
    [...records]
      .sort(byUpdatedAtDesc)
      .slice(0, Math.max(0, limit))
      .map((record) => record.id),
  );
}

function selectRetainedThreadIds(exchange: RuntimeExchange): Set<string> {
  const activeTaskIds = new Set(exchange.tasks.filter(isActiveTask).map((task) => task.id));
  const notificationThreads = exchange.threads.filter(isNotificationThread);
  const workflowThreads = exchange.threads.filter((thread) => !isNotificationThread(thread));
  const retained = new Set<string>();

  for (const thread of workflowThreads) {
    if (isActiveThread(thread, activeTaskIds)) retained.add(thread.id);
  }

  for (const thread of notificationThreads) {
    if ((thread.waitingOn ?? []).length > 0 || (thread.unreadBy ?? []).length > 0) retained.add(thread.id);
  }

  for (const threadId of selectLatestIds(notificationThreads, RUNTIME_EXCHANGE_RETENTION.notificationThreads)) {
    retained.add(threadId);
  }

  const closedWorkflowThreads = workflowThreads.filter((thread) => !retained.has(thread.id) && isClosedThread(thread));
  for (const threadId of selectLatestIds(closedWorkflowThreads, RUNTIME_EXCHANGE_RETENTION.closedWorkflowThreads)) {
    retained.add(threadId);
  }

  return retained;
}

function selectRetainedTaskIds(exchange: RuntimeExchange, retainedThreadIds: Set<string>): Set<string> {
  const retained = new Set<string>();
  for (const task of exchange.tasks) {
    if (isActiveTask(task)) retained.add(task.id);
    if (task.threadId && retainedThreadIds.has(task.threadId)) retained.add(task.id);
  }
  const closedTasks = exchange.tasks.filter((task) => !retained.has(task.id) && !isActiveTask(task));
  for (const taskId of selectLatestIds(closedTasks, RUNTIME_EXCHANGE_RETENTION.closedTasks)) {
    retained.add(taskId);
  }
  return retained;
}

function selectRetainedMessages(
  messagesByThreadId: Map<string, RuntimeExchangeMessage[]>,
  retainedThreads: RuntimeExchangeThread[],
): RuntimeExchangeMessage[] {
  const threadById = new Map(retainedThreads.map((thread) => [thread.id, thread] as const));
  const selectedIds = new Set<string>();
  for (const thread of retainedThreads) {
    const messages = messagesByThreadId.get(thread.id) ?? [];
    if (isNotificationThread(thread)) {
      const limit = RUNTIME_EXCHANGE_RETENTION.notificationThreadMessages;
      const lastMessage = thread.lastMessageId
        ? messages.find((message) => message.id === thread.lastMessageId)
        : undefined;
      const preferred = lastMessage ?? [...messages].sort(byUpdatedAtDesc)[0];
      let selectedForThread = 0;
      if (preferred && limit > 0) {
        selectedIds.add(preferred.id);
        selectedForThread = 1;
      }
      for (const message of [...messages]
        .sort(byUpdatedAtDesc)
        .filter((message) => message.id !== preferred?.id)
        .slice(0, Math.max(0, limit - selectedForThread))) {
        selectedIds.add(message.id);
        selectedForThread += 1;
      }
      continue;
    }
    const limit = isClosedThread(thread)
      ? RUNTIME_EXCHANGE_RETENTION.closedThreadMessages
      : RUNTIME_EXCHANGE_RETENTION.activeThreadMessages;
    for (const message of [...messages].sort(byUpdatedAtDesc).slice(0, limit)) {
      selectedIds.add(message.id);
    }
    if (thread.lastMessageId) selectedIds.add(thread.lastMessageId);
  }
  return [...messagesByThreadId.values()]
    .flat()
    .filter((message) => selectedIds.has(message.id) && threadById.has(message.threadId));
}

function subjectExists(
  kind: RuntimeExchangeWait["subjectKind"] | RuntimeExchangeInboxEntry["subjectKind"],
  id: string,
  refs: {
    threadIds: Set<string>;
    taskIds: Set<string>;
    handoffIds: Set<string>;
    reviewIds: Set<string>;
    messageIds: Set<string>;
  },
): boolean {
  if (kind === "thread") return refs.threadIds.has(id);
  if (kind === "task") return refs.taskIds.has(id);
  if (kind === "handoff") return refs.handoffIds.has(id);
  if (kind === "review") return refs.reviewIds.has(id);
  return refs.messageIds.has(id);
}

export function compactRuntimeExchange(exchange: RuntimeExchange): RuntimeExchangeCompactionReport {
  const before = countRuntimeExchangeRecords(exchange);
  const originalMessagesByThreadId = groupMessagesByThreadId(exchange.messages);
  const retainedThreadIds = selectRetainedThreadIds(exchange);
  const retainedTaskIds = selectRetainedTaskIds(exchange, retainedThreadIds);
  const retainedThreads = exchange.threads.filter((thread) => retainedThreadIds.has(thread.id));
  const retainedMessages = selectRetainedMessages(originalMessagesByThreadId, retainedThreads);
  const retainedMessageIds = new Set(retainedMessages.map((message) => message.id));
  const messagesByThreadId = new Map<string, RuntimeExchangeMessage[]>();
  for (const message of retainedMessages) {
    const messages = messagesByThreadId.get(message.threadId) ?? [];
    messages.push(message);
    messagesByThreadId.set(message.threadId, messages);
  }

  const threads = retainedThreads.map((thread) => ({
    ...thread,
    lastMessageId:
      thread.lastMessageId && retainedMessageIds.has(thread.lastMessageId)
        ? thread.lastMessageId
        : latestRetainedMessageId(messagesByThreadId.get(thread.id) ?? []),
  }));
  const threadIds = new Set(threads.map((thread) => thread.id));
  const tasks = exchange.tasks
    .filter(
      (task) => retainedTaskIds.has(task.id) && (!task.threadId || threadIds.has(task.threadId) || isActiveTask(task)),
    )
    .map((task) => (task.threadId && !threadIds.has(task.threadId) ? { ...task, threadId: undefined } : task));
  const taskIds = new Set(tasks.map((task) => task.id));
  const handoffs = exchange.handoffs.filter((handoff) => threadIds.has(handoff.threadId));
  const handoffIds = new Set(handoffs.map((handoff) => handoff.id));
  const reviews = exchange.reviews.filter((review) => taskIds.has(review.taskId));
  const reviewIds = new Set(reviews.map((review) => review.id));
  const refs = { threadIds, taskIds, handoffIds, reviewIds, messageIds: retainedMessageIds };
  const attachmentRefs = exchange.attachmentRefs.filter((ref: RuntimeExchangeAttachmentRef) => {
    if (ref.threadId && !threadIds.has(ref.threadId)) return false;
    if (ref.messageId && !retainedMessageIds.has(ref.messageId)) return false;
    return true;
  });
  const retained: RuntimeExchange = {
    ...exchange,
    threads,
    messages: retainedMessages,
    tasks,
    handoffs,
    reviews,
    waits: exchange.waits.filter((wait) => subjectExists(wait.subjectKind, wait.subjectId, refs)),
    inbox: exchange.inbox.filter((entry) => subjectExists(entry.subjectKind, entry.subjectId, refs)),
    planRefs: exchange.planRefs.filter(
      (ref) => (!ref.threadId || threadIds.has(ref.threadId)) && (!ref.taskId || taskIds.has(ref.taskId)),
    ),
    continuityRefs: exchange.continuityRefs.filter((ref) => !ref.threadId || threadIds.has(ref.threadId)),
    attachmentRefs,
  };
  const after = countRuntimeExchangeRecords(retained);
  const removed = subtractCounts(before, after);
  return {
    retained,
    before,
    after,
    removed,
    retention: RUNTIME_EXCHANGE_RETENTION,
    changed: removed.totalRecords > 0,
  };
}
