import type { ChatMessage } from "@/lib/events";

export interface AcceptedComposerEcho {
  baselineMessageCount: number;
  baselineUserMessageCount: number;
  clientMessageId: string;
  createdAtMs: number;
  message: ChatMessage;
  settled?: boolean;
}

export interface ComposerEchoMergeResult {
  messages: ChatMessage[];
  echoes: AcceptedComposerEcho[];
  droppedUnconfirmedCount: number;
}

export const COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS = 10_000;

function mergeConfirmedMessage(parsed: ChatMessage, accepted: AcceptedComposerEcho): ChatMessage {
  return {
    ...parsed,
    clientMessageId: accepted.clientMessageId,
  };
}

function confirmationSlotIndex(
  parsedMessages: readonly ChatMessage[],
  accepted: AcceptedComposerEcho,
  claimedParsedIndexes: ReadonlySet<number>,
): number {
  let userIndex = -1;
  for (let index = 0; index < parsedMessages.length; index += 1) {
    const message = parsedMessages[index];
    if (message?.role !== "user") continue;
    userIndex += 1;
    if (userIndex < accepted.baselineUserMessageCount) continue;
    if (claimedParsedIndexes.has(index)) continue;
    return index;
  }
  return -1;
}

export function mergeAcceptedComposerEchoes(
  parsedMessages: readonly ChatMessage[],
  acceptedEchoes: readonly AcceptedComposerEcho[],
  options: {
    nowMs: number;
    timeoutMs?: number;
  },
): ComposerEchoMergeResult {
  if (acceptedEchoes.length === 0) {
    return { messages: [...parsedMessages], echoes: [], droppedUnconfirmedCount: 0 };
  }

  const timeoutMs = options.timeoutMs ?? COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS;
  const claimedParsedIndexes = new Set<number>();
  const replacements = new Map<number, ChatMessage>();
  const retainedEchoes: AcceptedComposerEcho[] = [];
  const pendingEchoes: AcceptedComposerEcho[] = [];
  let droppedUnconfirmedCount = 0;

  for (const accepted of acceptedEchoes) {
    const matchIndex = confirmationSlotIndex(parsedMessages, accepted, claimedParsedIndexes);
    if (matchIndex >= 0) {
      claimedParsedIndexes.add(matchIndex);
      replacements.set(matchIndex, mergeConfirmedMessage(parsedMessages[matchIndex]!, accepted));
      retainedEchoes.push(accepted.settled ? accepted : { ...accepted, settled: true });
      continue;
    }

    const transcriptAdvanced = parsedMessages.length > accepted.baselineMessageCount;
    const expired = options.nowMs - accepted.createdAtMs >= timeoutMs;
    if (accepted.settled || transcriptAdvanced || expired) {
      droppedUnconfirmedCount += 1;
      continue;
    }

    retainedEchoes.push(accepted);
    pendingEchoes.push(accepted);
  }

  const messages = parsedMessages.map((message, index) => replacements.get(index) ?? message);
  let inserted = 0;
  for (const accepted of pendingEchoes) {
    const insertAt = Math.min(accepted.baselineMessageCount + inserted, messages.length);
    messages.splice(insertAt, 0, accepted.message);
    inserted += 1;
  }

  return { messages, echoes: retainedEchoes, droppedUnconfirmedCount };
}
