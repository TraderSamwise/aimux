import type { ChatMessage, HistoryPart, ParsedAgentOutput } from "@/lib/events";

function blockType(block: { type?: string; kind?: string }): string {
  return String(block.type ?? block.kind ?? "").trim();
}

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").trim();
}

export function messageText(message: Pick<ChatMessage, "parts" | "text">): string {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    return message.parts
      .filter((part): part is Extract<HistoryPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return String(message.text ?? "").trim();
}

export function messagesFromParsedAgentOutput(parsed?: ParsedAgentOutput | null): ChatMessage[] {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const messages: ChatMessage[] = [];

  blocks.forEach((block, index) => {
    const type = blockType(block);
    const text = normalizeText(String(block.text ?? ""));
    if (!text) return;
    if (type !== "prompt" && type !== "response") return;

    messages.push({
      id: `parsed-${index}-${type}`,
      role: type === "prompt" ? "user" : "assistant",
      parts: [{ type: "text", text }],
    });
  });

  return messages;
}

export function pendingPromptAlreadyRendered(
  pending: Pick<ChatMessage, "parts" | "text" | "deliveryState">,
  renderedMessages: ChatMessage[],
): boolean {
  if (pending.deliveryState === "failed") return false;
  const pendingText = normalizeText(messageText(pending));
  if (!pendingText) return false;
  return renderedMessages.some(
    (message) => message.role === "user" && normalizeText(messageText(message)) === pendingText,
  );
}
