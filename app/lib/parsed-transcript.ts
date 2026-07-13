import type {
  ChatMessage,
  HistoryImageReferencePart,
  HistoryPart,
  ParsedAgentOutput,
} from "@/lib/events";

type ImageLabelState = {
  labelsByKey: Map<string, string>;
  nextIndex: number;
};

const ATTACHED_IMAGE_LINE =
  /^\s*-\s+(.+?)\s+\((image\/[^,]+),\s+\d+\s+bytes\):\s+(.+?\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)\.[^\s/]+)\s*$/;
const INLINE_ATTACHED_IMAGE =
  /^(.*?)\s*Attached image files:\s*-\s+(.+?)\s+\((image\/[^,]+),\s+\d+\s+bytes\):\s+(.+?\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)\.[^\s/]+)\s*$/;
const FLATTENED_ATTACHMENTS_HEADER = /\bAttached image files:\s*/;
const FLATTENED_ATTACHMENT_ITEM =
  /-\s+(.+?)\s+\((image\/[^,]+),\s+\d+\s+bytes\):\s+(\S*?\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)\.[^\s/]+)/g;
const VIEWED_IMAGE_PATH =
  /^\s*(?:[└⎿L]\s*)?(?:\.aimux\/attachments\/|.+?\.aimux\/attachments\/)(att_[A-Za-z0-9_-]+)\.[^\s/]+\s*$/;

function blockType(block: { type?: string; kind?: string }): string {
  return String(block.type ?? block.kind ?? "").trim();
}

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").trim();
}

function imageLabelFor(state: ImageLabelState, key: string): string {
  const existing = state.labelsByKey.get(key);
  if (existing) return existing;
  const label = `[image #${state.nextIndex}]`;
  state.nextIndex += 1;
  state.labelsByKey.set(key, label);
  return label;
}

function imageReferenceFor(
  state: ImageLabelState,
  attachmentId: string,
  opts: { filename?: string; mimeType?: string } = {},
): HistoryImageReferencePart {
  return {
    type: "image_reference",
    label: imageLabelFor(state, attachmentId),
    attachmentId,
    filename: opts.filename,
    mimeType: opts.mimeType,
    contentUrl: `/attachments/${attachmentId}/content`,
  };
}

function flushTextPart(parts: HistoryPart[], lines: string[]) {
  const text = lines.join("\n").trim();
  if (text) parts.push({ type: "text", text });
  lines.length = 0;
}

function partsFromFlattenedAttachmentText(
  text: string,
  imageLabels: ImageLabelState,
): HistoryPart[] | null {
  if (!text.includes("Attached image files:")) return null;

  const flattened = text.replace(/\s+/g, " ").trim();
  const headerMatch = flattened.match(FLATTENED_ATTACHMENTS_HEADER);
  if (!headerMatch?.index && headerMatch?.index !== 0) return null;
  const headerEnd = headerMatch.index + headerMatch[0].length;
  const head = flattened.slice(0, headerMatch.index).trim();
  const tail = flattened.slice(headerEnd);
  const parts: HistoryPart[] = [];
  if (head) parts.push({ type: "text", text: head });
  let cursor = 0;
  let matched = false;
  FLATTENED_ATTACHMENT_ITEM.lastIndex = 0;

  for (const match of tail.matchAll(FLATTENED_ATTACHMENT_ITEM)) {
    if (!match[4] || match.index === undefined) continue;
    const between = tail.slice(cursor, match.index).trim();
    if (between) parts.push({ type: "text", text: between });
    parts.push(
      imageReferenceFor(imageLabels, match[4], {
        filename: match[1],
        mimeType: match[2],
      }),
    );
    cursor = match.index + match[0].length;
    matched = true;
  }

  if (!matched) return null;
  const suffix = tail.slice(cursor).trim();
  if (suffix) parts.push({ type: "text", text: suffix });
  return parts;
}

function partsFromTranscriptText(text: string, imageLabels: ImageLabelState): HistoryPart[] {
  const flattenedAttachmentParts = partsFromFlattenedAttachmentText(text, imageLabels);
  if (flattenedAttachmentParts) return flattenedAttachmentParts;

  const lines = text.split("\n");
  const parts: HistoryPart[] = [];
  const textLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const inlineAttachment = line.match(INLINE_ATTACHED_IMAGE);
    if (inlineAttachment?.[5]) {
      const prefix = inlineAttachment[1]?.trim();
      if (prefix) textLines.push(prefix);
      flushTextPart(parts, textLines);
      parts.push(
        imageReferenceFor(imageLabels, inlineAttachment[5], {
          filename: inlineAttachment[2],
          mimeType: inlineAttachment[3],
        }),
      );
      continue;
    }

    if (/^\s*Attached image files:\s*$/.test(line)) {
      const imageParts: HistoryImageReferencePart[] = [];
      let nextIndex = index + 1;

      while (nextIndex < lines.length) {
        const match = (lines[nextIndex] ?? "").match(ATTACHED_IMAGE_LINE);
        if (!match) break;
        imageParts.push(
          imageReferenceFor(imageLabels, match[4] ?? match[3] ?? "", {
            filename: match[1],
            mimeType: match[2],
          }),
        );
        nextIndex += 1;
      }

      if (imageParts.length > 0) {
        flushTextPart(parts, textLines);
        parts.push(...imageParts);
        index = nextIndex - 1;
        continue;
      }
    }

    if (/^\s*Viewed Image\s*$/i.test(line)) {
      const pathLineIndex = index + 1;
      const match = (lines[pathLineIndex] ?? "").match(VIEWED_IMAGE_PATH);
      if (match?.[1]) {
        flushTextPart(parts, textLines);
        parts.push(imageReferenceFor(imageLabels, match[1]));
        index = pathLineIndex;
        continue;
      }
    }

    textLines.push(line);
  }

  flushTextPart(parts, textLines);
  return parts.length > 0 ? parts : [{ type: "text", text }];
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
  const imageLabels: ImageLabelState = { labelsByKey: new Map(), nextIndex: 1 };

  blocks.forEach((block, index) => {
    const type = blockType(block);
    const text = normalizeText(String(block.text ?? ""));
    if (!text) return;
    if (type !== "prompt" && type !== "response") return;

    messages.push({
      id: `parsed-${index}-${type}`,
      role: type === "prompt" ? "user" : "assistant",
      parts: partsFromTranscriptText(text, imageLabels),
    });
  });

  return messages;
}
