export type ChatMessageIdentity = {
  clientMessageId?: string;
  id?: string;
  role?: string;
};

function chatMessageIdentity(message: ChatMessageIdentity, index: number): string {
  return message.id ?? message.clientMessageId ?? `${message.role ?? "message"}:${index}`;
}

function frozenPrefixMessageMatches(
  frozenMessage: ChatMessageIdentity,
  liveMessage: ChatMessageIdentity,
  index: number,
  frozenLength: number,
): boolean {
  const frozenIdentity = chatMessageIdentity(frozenMessage, index);
  if (frozenIdentity === chatMessageIdentity(liveMessage, index)) return true;
  return (
    index === frozenLength - 1 &&
    frozenMessage.id?.endsWith(":latest") === true &&
    frozenMessage.role === liveMessage.role
  );
}

export function chatFrozenNewMessageCount<TMessage extends ChatMessageIdentity>({
  frozenMessages,
  liveMessages,
}: {
  frozenMessages: readonly TMessage[];
  liveMessages: readonly TMessage[];
}): number {
  if (liveMessages.length <= frozenMessages.length) return 0;

  for (let index = 0; index < frozenMessages.length; index += 1) {
    if (
      !frozenPrefixMessageMatches(
        frozenMessages[index]!,
        liveMessages[index]!,
        index,
        frozenMessages.length,
      )
    ) {
      return 0;
    }
  }

  return liveMessages.length - frozenMessages.length;
}
