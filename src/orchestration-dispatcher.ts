import { listThreads, markMessageDelivered, readMessages, type MessageKind } from "./threads.js";
import type { SessionAvailability } from "./session-semantics.js";

interface DispatchSession {
  id: string;
  exited: boolean;
  status: string;
  write(data: string): void;
}

type PromptDelivery = (session: DispatchSession, prompt: string) => void;

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

  constructor(
    private readonly getSession: (id: string) => DispatchSession | undefined,
    private readonly getSessionAvailability: (id: string) => SessionAvailability,
    private readonly deliverPrompt: PromptDelivery = (session, prompt) => session.write(prompt + "\r"),
  ) {}

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
          const availability = this.getSessionAvailability(recipient);
          const canDeliver = availability === "available" || availability === "needs_input";
          if (!canDeliver) continue;
          const prompt =
            `Aimux: new ${message.kind} for you.\n\n` +
            `Thread: ${thread.id}\n` +
            `Message: ${message.id}\n` +
            `From: ${message.from}\n\n` +
            `Run:\n` +
            `  aimux thread show ${thread.id}\n\n` +
            `Then reply, accept, complete, or request clarification using aimux as appropriate.`;
          this.deliverPrompt(session, prompt);
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
