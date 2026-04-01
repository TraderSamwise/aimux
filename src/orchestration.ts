import {
  appendMessage,
  createThread,
  listThreads,
  readThread,
  updateThread,
  type MessageKind,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadKind,
} from "./threads.js";

export interface SendThreadMessageInput {
  threadId: string;
  from: string;
  to?: string[];
  kind?: MessageKind;
  body: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SendDirectMessageInput {
  from?: string;
  to: string[];
  body: string;
  title?: string;
  kind?: Extract<MessageKind, "request" | "note" | "handoff" | "reply" | "status" | "decision">;
  worktreePath?: string;
  tags?: string[];
}

export interface SendMessageResult {
  thread: OrchestrationThread;
  message: OrchestrationMessage;
  threadCreated: boolean;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameParticipants(a: string[], b: string[]): boolean {
  const aSorted = [...unique(a)].sort();
  const bSorted = [...unique(b)].sort();
  if (aSorted.length !== bSorted.length) return false;
  return aSorted.every((value, idx) => value === bSorted[idx]);
}

function defaultConversationTitle(from: string, to: string[]): string {
  return `Conversation: ${from} → ${to.join(", ")}`;
}

function resolveRecipients(thread: OrchestrationThread, from: string, to?: string[]): string[] {
  const explicit = unique(to ?? []);
  if (explicit.length > 0) return explicit;
  return unique(thread.participants.filter((participant) => participant !== from && participant !== "user"));
}

function updateThreadForMessage(
  current: OrchestrationThread,
  from: string,
  recipients: string[],
  kind: MessageKind,
): OrchestrationThread {
  const participants = unique([...current.participants, from, ...recipients]);
  if (kind === "request" || kind === "handoff") {
    return {
      ...current,
      participants,
      status: recipients.length > 0 ? "waiting" : "open",
      owner: from,
      waitingOn: recipients,
    };
  }
  if (kind === "reply" || kind === "decision" || kind === "status") {
    return {
      ...current,
      participants,
      status: recipients.length > 0 ? "waiting" : "open",
      owner: from,
      waitingOn: recipients,
    };
  }
  return {
    ...current,
    participants,
    owner: current.owner ?? from,
  };
}

export function sendThreadMessage(input: SendThreadMessageInput): SendMessageResult {
  const thread = readThread(input.threadId);
  if (!thread) {
    throw new Error(`thread not found: ${input.threadId}`);
  }
  const recipients = resolveRecipients(thread, input.from, input.to);
  const kind = input.kind ?? "note";
  const message = appendMessage(thread.id, {
    from: input.from,
    to: recipients,
    kind,
    body: input.body,
    metadata: input.metadata,
  });
  const updated =
    updateThread(thread.id, (current) => updateThreadForMessage(current, input.from, recipients, kind)) ??
    readThread(thread.id);
  if (!updated) {
    throw new Error(`thread disappeared after update: ${thread.id}`);
  }
  return {
    thread: updated,
    message,
    threadCreated: false,
  };
}

export function findDirectConversationThread(participants: string[]): OrchestrationThread | undefined {
  return listThreads().find(
    (thread) =>
      thread.kind === "conversation" &&
      !thread.taskId &&
      thread.status !== "abandoned" &&
      sameParticipants(thread.participants, participants),
  );
}

export function sendDirectMessage(input: SendDirectMessageInput): SendMessageResult {
  const from = input.from?.trim() || "user";
  const recipients = unique(input.to);
  if (recipients.length === 0) {
    throw new Error("direct message requires at least one recipient");
  }
  const participants = unique([from, ...recipients]);
  const existing = findDirectConversationThread(participants);
  const thread =
    existing ??
    createThread({
      title: input.title?.trim() || defaultConversationTitle(from, recipients),
      kind: "conversation" satisfies ThreadKind,
      createdBy: from,
      participants,
      worktreePath: input.worktreePath,
      tags: input.tags,
      owner: from,
      waitingOn: recipients,
      status: recipients.length > 0 ? "waiting" : "open",
    });
  const result = sendThreadMessage({
    threadId: thread.id,
    from,
    to: recipients,
    kind: input.kind ?? "request",
    body: input.body,
  });
  return {
    ...result,
    threadCreated: !existing,
  };
}
