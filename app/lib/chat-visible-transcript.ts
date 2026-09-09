import type { ChatScrollIntent } from "./chat-scroll-policy";

export type ChatVisibleTranscript<TMessage> = {
  messages: readonly TMessage[];
  sessionKey: string;
};

export function chatVisibleTranscriptForPinned<TMessage>({
  liveMessages,
  sessionKey,
}: {
  liveMessages: readonly TMessage[];
  sessionKey: string;
}): ChatVisibleTranscript<TMessage> {
  return { messages: liveMessages, sessionKey };
}

export function chatVisibleTranscriptForLiveChange<TMessage>(
  current: ChatVisibleTranscript<TMessage>,
  {
    intent,
    liveMessages,
    sessionKey,
  }: {
    intent: ChatScrollIntent;
    liveMessages: readonly TMessage[];
    sessionKey: string;
  },
): ChatVisibleTranscript<TMessage> {
  if (current.sessionKey !== sessionKey || intent === "pinned") {
    return chatVisibleTranscriptForPinned({ liveMessages, sessionKey });
  }
  return current;
}

export function chatVisibleTranscriptMessages<TMessage>(
  current: ChatVisibleTranscript<TMessage>,
  {
    liveMessages,
    sessionKey,
  }: {
    liveMessages: readonly TMessage[];
    sessionKey: string;
  },
): readonly TMessage[] {
  return current.sessionKey === sessionKey ? current.messages : liveMessages;
}
