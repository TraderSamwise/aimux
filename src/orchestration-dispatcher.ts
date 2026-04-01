import { listThreads, markMessageDelivered, readMessages, type MessageKind } from "./threads.js";

interface DispatchSession {
  id: string;
  exited: boolean;
  status: string;
  write(data: string): void;
}

export interface OrchestrationDeliveryEvent {
  type: "message_delivered";
  threadId: string;
  messageId: string;
  sessionId: string;
  kind: MessageKind;
}

function shouldDispatch(kind: MessageKind): boolean {
  return kind === "request" || kind === "reply" || kind === "handoff" || kind === "decision" || kind === "status";
}

export class OrchestrationDispatcher {
  private pendingEvents: OrchestrationDeliveryEvent[] = [];

  constructor(private readonly getSession: (id: string) => DispatchSession | undefined) {}

  tick(localSessionIds: string[]): void {
    for (const thread of listThreads()) {
      const messages = readMessages(thread.id);
      for (const message of messages) {
        if (!message.to?.length || !shouldDispatch(message.kind)) continue;
        for (const recipient of message.to) {
          if ((message.deliveredTo ?? []).includes(recipient)) continue;
          if (!localSessionIds.includes(recipient)) continue;
          const session = this.getSession(recipient);
          if (!session || session.exited) continue;
          if (session.status !== "idle" && session.status !== "waiting") continue;
          const prompt =
            `[AIMUX MESSAGE ${thread.id} from ${message.from}] ${message.body}\n\n` +
            `Read .aimux/threads/${thread.id}.json and .aimux/threads/${thread.id}.jsonl for context. ` +
            `This is a ${message.kind} message. Reply in-thread if needed.`;
          session.write(prompt + "\r");
          markMessageDelivered(thread.id, message.id, recipient);
          this.pendingEvents.push({
            type: "message_delivered",
            threadId: thread.id,
            messageId: message.id,
            sessionId: recipient,
            kind: message.kind,
          });
        }
      }
    }
  }

  drainEvents(): OrchestrationDeliveryEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }
}
