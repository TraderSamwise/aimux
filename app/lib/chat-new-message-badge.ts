export type ChatMessageIdentity = {
  clientMessageId?: string;
  id?: string;
  role?: string;
};

function chatMessageIdentity(message: ChatMessageIdentity, index: number): string {
  return message.id ?? message.clientMessageId ?? `${message.role ?? "message"}:${index}`;
}

function isLatestIdentity(message: ChatMessageIdentity): boolean {
  return message.id?.endsWith(":latest") === true;
}

function latestTailRepresentsLiveMessage({
  consumed,
  frozenMessages,
  liveIndex,
  liveMessage,
}: {
  consumed: boolean;
  frozenMessages: readonly ChatMessageIdentity[];
  liveIndex: number;
  liveMessage: ChatMessageIdentity;
}): boolean {
  if (consumed || frozenMessages.length === 0) return false;
  const frozenTail = frozenMessages[frozenMessages.length - 1];
  return (
    liveIndex === frozenMessages.length - 1 &&
    isLatestIdentity(frozenTail!) &&
    frozenTail!.role === liveMessage.role
  );
}

export function chatFrozenNewMessageCount<TMessage extends ChatMessageIdentity>({
  frozenMessages,
  liveMessages,
}: {
  frozenMessages: readonly TMessage[];
  liveMessages: readonly TMessage[];
}): number {
  if (liveMessages.length === 0) return 0;
  if (frozenMessages.length === 0) return liveMessages.length;

  const frozenIdentities = new Set(
    frozenMessages.filter((message) => !isLatestIdentity(message)).map(chatMessageIdentity),
  );
  let representedLatestTail = false;
  let sharedStableMessageCount = 0;
  let unseenLiveMessageCount = 0;

  for (let liveIndex = 0; liveIndex < liveMessages.length; liveIndex += 1) {
    const liveMessage = liveMessages[liveIndex]!;
    const liveIdentity = chatMessageIdentity(liveMessage, liveIndex);
    if (frozenIdentities.has(liveIdentity)) {
      sharedStableMessageCount += 1;
      continue;
    }
    if (
      latestTailRepresentsLiveMessage({
        consumed: representedLatestTail,
        frozenMessages,
        liveIndex,
        liveMessage,
      })
    ) {
      representedLatestTail = true;
      continue;
    }
    unseenLiveMessageCount += 1;
  }

  if (sharedStableMessageCount === 0 && frozenIdentities.size > 0) return 0;
  if (sharedStableMessageCount === 0 && !representedLatestTail) return 0;
  return unseenLiveMessageCount;
}
