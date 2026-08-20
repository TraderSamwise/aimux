import { createHash } from "node:crypto";

import { parseAgentOutput } from "./agent-output-parser.js";
import type {
  AgentTranscriptAttachmentPart,
  AgentTranscriptImagePart,
  AgentTranscriptMessage,
  AgentTranscriptPart,
  RichTextSpan,
} from "./agent-transcript-contract.js";
import { ATTACHMENT_MIME_PATTERN, recoverWrappedAttachments } from "./attachment-text.js";
import { parseSgrRichTextLines, richTextLineText, sliceRichTextSpans } from "./rich-text.js";
export type {
  AgentTranscriptAttachmentPart,
  AgentTranscriptImagePart,
  AgentTranscriptMessage,
  AgentTranscriptPart,
  AgentTranscriptTextPart,
} from "./agent-transcript-contract.js";

/**
 * The pane, projected into a conversation.
 *
 * This used to live in the GUI, and a second copy of it grew in a downstream
 * consumer. Both drifted. It belongs here because the block shapes it reads are
 * produced here, by the parser it sits next to — a client that is handed
 * `messages` cannot fall behind the parser that made them.
 *
 * What it deliberately does NOT do is decide how anything looks. No widths, no
 * colours, no URLs: `attachmentId` is emitted rather than a path, because the
 * same attachment is reachable at three different shapes depending on whether
 * the caller is local, on the relay, or behind somebody's own proxy — and the
 * server is not in a position to know which.
 */

/**
 * Structural on purpose: the parser's own block type, and any client's looser
 * idea of one, both satisfy it. No index signature — the parser's blocks are
 * a closed type and would not be assignable to one.
 */
interface TranscriptBlock {
  type?: string;
  kind?: string;
  text?: string;
  sourceLines?: readonly {
    lineIndex: number;
    text: string;
  }[];
}

export interface ParsedAgentOutputLike {
  blocks?: readonly TranscriptBlock[];
}

const ATTACHED_FILE_LINE = new RegExp(
  `^\\s*-\\s+(.+?)\\s+\\((${ATTACHMENT_MIME_PATTERN}),\\s+\\d+\\s+bytes\\):\\s+(.+?\\.aimux\\/attachments\\/(att_[A-Za-z0-9_-]+)\\.[^\\s/]+)\\s*$`,
);
const INLINE_ATTACHED_FILE = new RegExp(
  `^(.*?)\\s*Attached (?:image )?files:\\s*-\\s+(.+?)\\s+\\((${ATTACHMENT_MIME_PATTERN}),\\s+\\d+\\s+bytes\\):\\s+(.+?\\.aimux\\/attachments\\/(att_[A-Za-z0-9_-]+)\\.[^\\s/]+)\\s*$`,
);
const FLATTENED_ATTACHMENTS_HEADER = /\bAttached (?:image )?files:\s*/;
const FLATTENED_ATTACHMENT_ITEM = new RegExp(
  `-\\s+(.+?)\\s+\\((${ATTACHMENT_MIME_PATTERN}),\\s+\\d+\\s+bytes\\):\\s+(\\S*?\\.aimux\\/attachments\\/(att_[A-Za-z0-9_-]+)\\.[^\\s/]+)`,
  "g",
);
const VIEWED_ATTACHMENT_PATH =
  /^\s*(?:[└⎿L]\s*)?(?:\.aimux\/attachments\/|.+?\.aimux\/attachments\/)(att_[A-Za-z0-9_-]+)\.[^\s/]+\s*$/;

type AttachmentLabels = { byId: Map<string, string>; nextImage: number; nextFile: number };
type AttachmentContent = { contentUrl?: string; hostedContentUrl?: string; hostedExpiresAt?: string };
type AttachmentContentResolver = (attachmentId: string) => AttachmentContent | null | undefined;

function blockType(block: TranscriptBlock): string {
  return String(block.type ?? block.kind ?? "").trim();
}

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").trim();
}

function isDividerOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 3 && /^[\u2500-\u257f\-_=\s]+$/.test(trimmed);
}

function isTerminalCompletionLine(line: string): boolean {
  const trimmed = line.trim().replace(/^[—–-]\s+/, "");
  return /^Worked\s+for\s+\d+(?:ms|s|m|h)\b/i.test(trimmed);
}

function stripTrailingTerminalChrome(text: string): string {
  const lines = normalizeText(text).split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1]!.trim() === "" || isDividerOnlyLine(lines[end - 1]!))) {
    end -= 1;
  }
  if (end > 0 && isTerminalCompletionLine(lines[end - 1]!)) {
    return lines
      .slice(0, end - 1)
      .join("\n")
      .trim();
  }
  return lines.join("\n").trim();
}

function attachmentKindForMimeType(mimeType?: string): AgentTranscriptAttachmentPart["kind"] | "image" {
  const normalized = mimeType?.toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  if (normalized.startsWith("text/") || normalized === "application/json") return "text";
  return "file";
}

function labelFor(
  labels: AttachmentLabels,
  attachmentId: string,
  kind: AgentTranscriptAttachmentPart["kind"] | "image",
): string {
  const existing = labels.byId.get(attachmentId);
  if (existing) return existing;
  const label = kind === "image" ? `[image #${labels.nextImage++}]` : `[file #${labels.nextFile++}]`;
  labels.byId.set(attachmentId, label);
  return label;
}

function imagePart(
  labels: AttachmentLabels,
  attachmentId: string,
  opts: { filename?: string; mimeType?: string } = {},
): AgentTranscriptImagePart {
  return {
    type: "image_reference",
    label: labelFor(labels, attachmentId, "image"),
    attachmentId,
    filename: opts.filename,
    mimeType: opts.mimeType,
  };
}

function attachmentPart(
  labels: AttachmentLabels,
  attachmentId: string,
  opts: { filename?: string; mimeType?: string } = {},
): AgentTranscriptImagePart | AgentTranscriptAttachmentPart {
  const kind = attachmentKindForMimeType(opts.mimeType);
  if (kind === "image") return imagePart(labels, attachmentId, opts);
  return {
    type: "attachment_reference",
    label: labelFor(labels, attachmentId, kind),
    attachmentId,
    filename: opts.filename,
    mimeType: opts.mimeType,
    kind,
  };
}

function flushText(parts: AgentTranscriptPart[], lines: string[]) {
  const text = lines.join("\n").trim();
  if (text) parts.push({ type: "text", text });
  lines.length = 0;
}

function richSpansFromSourceLines(
  sourceLines: TranscriptBlock["sourceLines"],
  richLines: readonly (readonly RichTextSpan[])[] | undefined,
): RichTextSpan[] | undefined {
  if (!sourceLines?.length || !richLines?.length) return undefined;
  const spans: RichTextSpan[] = [];
  for (const sourceLine of sourceLines) {
    if (sourceLine.lineIndex < 0) {
      if (spans.length > 0) spans.push({ text: "\n" });
      continue;
    }
    const line = richLines[sourceLine.lineIndex];
    if (!line) return undefined;
    if (spans.length > 0) spans.push({ text: "\n" });
    if (!sourceLine.text) continue;
    const plain = richTextLineText(line).trimEnd();
    const start = plain.indexOf(sourceLine.text);
    if (start < 0) return undefined;
    spans.push(...sliceRichTextSpans(line, start, start + sourceLine.text.length));
  }
  return spans.length > 0 ? spans : undefined;
}

function textFromRichSpans(spans: readonly RichTextSpan[]): string {
  return spans.map((span) => span.text).join("");
}

function applyRichSpansToTextParts(
  parts: AgentTranscriptPart[],
  rawText: string,
  richSpans: readonly RichTextSpan[] | undefined,
): void {
  if (!richSpans?.length) return;
  const richText = textFromRichSpans(richSpans);
  if (richText !== rawText) return;

  let cursor = 0;
  for (const part of parts) {
    if (part.type !== "text") continue;
    const start = rawText.indexOf(part.text, cursor);
    if (start < 0) continue;
    const spans = sliceRichTextSpans(richSpans, start, start + part.text.length);
    if (spans.length > 0) part.spans = spans;
    cursor = start + part.text.length;
  }
}

/**
 * tmux wraps, and the wrap lands mid-path.
 *
 * When the attachment block has been reflowed into one run of words the
 * line-based reader below cannot see it, so whitespace is collapsed first and
 * the ids are recovered from the flattened text.
 */
function partsFromFlattened(text: string, labels: AttachmentLabels): AgentTranscriptPart[] | null {
  if (!/\bAttached (?:image )?files:/.test(text)) return null;

  const flattened = text.replace(/\s+/g, " ").trim();
  const header = flattened.match(FLATTENED_ATTACHMENTS_HEADER);
  if (header?.index === undefined) return null;
  const imageHeader = /\bAttached image files:/i.test(header[0]);

  const parts: AgentTranscriptPart[] = [];
  const head = flattened.slice(0, header.index).trim();
  const tail = flattened.slice(header.index + header[0].length);
  if (head) parts.push({ type: "text", text: head });

  let cursor = 0;
  let matched = false;
  FLATTENED_ATTACHMENT_ITEM.lastIndex = 0;

  for (const match of tail.matchAll(FLATTENED_ATTACHMENT_ITEM)) {
    if (!match[4] || match.index === undefined) continue;
    const between = tail.slice(cursor, match.index).trim();
    if (between) parts.push({ type: "text", text: between });
    parts.push(attachmentPart(labels, match[4], { filename: match[1], mimeType: match[2] }));
    cursor = match.index + match[0].length;
    matched = true;
  }

  // Collapsing to a space is not enough when the wrap fell inside the path
  // itself — `.aimux/attach ments/att_…` matches nothing. Observed on a live
  // box. `recoverWrappedAttachments` takes the spaces out entirely, which puts
  // the id back together and the item's metadata with it; the header is only
  // consulted for what that metadata does not say.
  if (!matched) {
    const recovered = recoverWrappedAttachments(tail);
    if (!recovered) return null;
    if (recovered.prose) parts.push({ type: "text", text: recovered.prose });
    for (const attachment of recovered.attachments) {
      parts.push(
        attachmentPart(labels, attachment.attachmentId, {
          filename: attachment.filename,
          mimeType: attachment.mimeType ?? (imageHeader ? "image/unknown" : undefined),
        }),
      );
    }
    return parts;
  }
  const suffix = tail.slice(cursor).trim();
  if (suffix) parts.push({ type: "text", text: suffix });
  return parts;
}

function partsFromText(text: string, labels: AttachmentLabels): AgentTranscriptPart[] {
  const flattened = partsFromFlattened(text, labels);
  if (flattened) return flattened;

  const lines = text.split("\n");
  const parts: AgentTranscriptPart[] = [];
  const textLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const inline = line.match(INLINE_ATTACHED_FILE);
    if (inline?.[5]) {
      const prefix = inline[1]?.trim();
      if (prefix) textLines.push(prefix);
      flushText(parts, textLines);
      parts.push(
        attachmentPart(labels, inline[5], {
          filename: inline[2],
          mimeType: inline[3],
        }),
      );
      continue;
    }

    if (/^\s*Attached (?:image )?files:\s*$/.test(line)) {
      const attachments: AgentTranscriptPart[] = [];
      let next = index + 1;
      while (next < lines.length) {
        const match = (lines[next] ?? "").match(ATTACHED_FILE_LINE);
        if (!match) break;
        attachments.push(
          attachmentPart(labels, match[4] ?? "", {
            filename: match[1],
            mimeType: match[2],
          }),
        );
        next += 1;
      }
      if (attachments.length > 0) {
        flushText(parts, textLines);
        parts.push(...attachments);
        index = next - 1;
        continue;
      }
    }

    const viewed = line.match(/^\s*Viewed (Image|File|Attachment)\s*$/i);
    if (viewed) {
      const pathLine = index + 1;
      const match = (lines[pathLine] ?? "").match(VIEWED_ATTACHMENT_PATH);
      if (match?.[1]) {
        flushText(parts, textLines);
        parts.push(
          attachmentPart(labels, match[1], viewed[1]?.toLowerCase() === "image" ? { mimeType: "image/unknown" } : {}),
        );
        index = pathLine;
        continue;
      }
    }

    textLines.push(line);
  }

  flushText(parts, textLines);
  return parts.length > 0 ? parts : [{ type: "text", text }];
}

export function transcriptMessageText(parts: readonly AgentTranscriptPart[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Short, and not a security boundary — only message identity depends on it. */
function contentId(role: string, text: string): string {
  return `${role}:${createHash("sha1").update(text).digest("hex").slice(0, 12)}`;
}

export function messagesFromParsedAgentOutput(
  parsed?: ParsedAgentOutputLike | null,
  options: {
    richLines?: readonly (readonly RichTextSpan[])[];
    attachmentContentForId?: AttachmentContentResolver;
  } = {},
): AgentTranscriptMessage[] {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const messages: AgentTranscriptMessage[] = [];
  const labels: AttachmentLabels = { byId: new Map(), nextImage: 1, nextFile: 1 };
  // The same words twice is a legitimate conversation — "yes", "yes" — so a
  // repeat is numbered rather than allowed to collide.
  const seen = new Map<string, number>();

  for (const block of blocks) {
    const type = blockType(block);
    if (type !== "prompt" && type !== "response") continue;
    const raw =
      type === "response"
        ? stripTrailingTerminalChrome(String(block.text ?? ""))
        : normalizeText(String(block.text ?? ""));
    if (!raw) continue;

    const role = type === "prompt" ? "user" : "assistant";
    const base = contentId(role, raw);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    const parts = partsFromText(raw, labels);
    applyAttachmentContent(parts, options.attachmentContentForId);
    applyRichSpansToTextParts(parts, raw, richSpansFromSourceLines(block.sourceLines, options.richLines));
    messages.push({
      id: count === 1 ? base : `${base}#${count}`,
      role,
      parts,
      text: transcriptMessageText(parts),
    });
  }

  const newest = messages[messages.length - 1];
  if (newest) newest.latest = true;

  return messages;
}

/** An attachment the session published, as the store recorded it. */
export interface PublishedAttachmentForTranscript {
  attachmentId: string;
  /** Where it was already merged, so it stays with that turn. */
  anchorMessageId?: string;
  /**
   * May it re-attach if that turn's id moved? Message ids hash the reply text,
   * so a streaming answer changes id under the anchor — briefly re-anchorable
   * covers that without letting an old image walk down the page forever.
   */
  canReanchor?: boolean;
  filename?: string;
  mimeType?: string;
  contentUrl?: string;
  hostedContentUrl?: string;
  hostedExpiresAt?: string;
}

/**
 * Put published attachments into the transcript when the pane never showed
 * them.
 *
 * Reading them out of the terminal is best-effort by nature: an agent's UI
 * collapses long tool output, and codex prints its result under a `└` gutter
 * that the parser reads as status. Either way the line naming the attachment is
 * gone, and an image the agent deliberately published shows up as prose about
 * an image. What the store recorded does not depend on any of that.
 */
/**
 * The message the merge invents when a publish has no reply to sit under. It is
 * rebuilt from the same attachment id on every read, so an anchor pointing at
 * it stays valid even though the parser never produces it.
 */
const PUBLISHED_MESSAGE_ID_PREFIX = "assistant:published:";

export function mergePublishedAttachments(
  messages: AgentTranscriptMessage[],
  published: readonly PublishedAttachmentForTranscript[],
): { messages: AgentTranscriptMessage[]; anchors: Array<{ attachmentId: string; messageId: string }> } {
  if (published.length === 0) return { messages, anchors: [] };
  const alreadyShown = new Set<string>();
  const messageIds = new Set<string>();
  for (const message of messages) {
    messageIds.add(message.id);
    for (const part of message.parts) {
      if (part.type === "image_reference" || part.type === "attachment_reference") {
        alreadyShown.add(part.attachmentId);
      }
    }
  }
  const missing = published.filter((entry) => {
    if (alreadyShown.has(entry.attachmentId)) return false;
    // Anchored to a turn that has scrolled out of the window: the reply it
    // belonged to is gone, and showing it under a later one is how an image
    // ends up following the conversation down the page.
    if (entry.anchorMessageId?.startsWith(PUBLISHED_MESSAGE_ID_PREFIX)) return true;
    if (entry.anchorMessageId && !messageIds.has(entry.anchorMessageId)) return entry.canReanchor === true;
    return true;
  });
  if (missing.length === 0) return { messages, anchors: [] };

  const labels: AttachmentLabels = { byId: new Map(), nextImage: 1, nextFile: 1 };
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "image_reference") labels.nextImage += 1;
      else if (part.type === "attachment_reference") labels.nextFile += 1;
    }
  }

  const partFor = (entry: PublishedAttachmentForTranscript) => {
    const part = attachmentPart(labels, entry.attachmentId, {
      filename: entry.filename,
      mimeType: entry.mimeType,
    });
    if (entry.contentUrl) part.contentUrl = entry.contentUrl;
    if (entry.hostedContentUrl) part.hostedContentUrl = entry.hostedContentUrl;
    if (entry.hostedExpiresAt) part.hostedExpiresAt = entry.hostedExpiresAt;
    return part;
  };

  // Oldest first, so they read in the order they were published.
  const ordered = [...missing].reverse();
  const merged = messages.map((message) => ({ ...message, parts: [...message.parts] }));
  const byId = new Map(merged.map((message) => [message.id, message]));
  const anchors: Array<{ attachmentId: string; messageId: string }> = [];
  const unanchored: PublishedAttachmentForTranscript[] = [];

  for (const entry of ordered) {
    const anchored = entry.anchorMessageId ? byId.get(entry.anchorMessageId) : undefined;
    if (!anchored) {
      unanchored.push(entry);
      continue;
    }
    anchored.parts.push(partFor(entry));
    anchored.text = transcriptMessageText(anchored.parts);
  }

  if (unanchored.length > 0) {
    const parts = unanchored.map(partFor);
    const tail = merged[merged.length - 1];
    if (tail && tail.role === "assistant") {
      tail.parts.push(...parts);
      tail.text = transcriptMessageText(tail.parts);
      for (const entry of unanchored) anchors.push({ attachmentId: entry.attachmentId, messageId: tail.id });
    } else {
      for (const message of merged) delete message.latest;
      const publishedMessageId = `${PUBLISHED_MESSAGE_ID_PREFIX}${unanchored[0].attachmentId}`;
      merged.push({
        id: publishedMessageId,
        role: "assistant",
        parts,
        text: transcriptMessageText(parts),
        latest: true,
      });
      for (const entry of unanchored) {
        anchors.push({ attachmentId: entry.attachmentId, messageId: publishedMessageId });
      }
    }
  }

  return { messages: merged, anchors };
}

function applyAttachmentContent(parts: AgentTranscriptPart[], resolver: AttachmentContentResolver | undefined): void {
  if (!resolver) return;
  for (const part of parts) {
    if (part.type !== "image_reference" && part.type !== "attachment_reference") continue;
    const content = resolver(part.attachmentId);
    if (!content?.contentUrl) continue;
    part.contentUrl = content.contentUrl;
    if (content.hostedContentUrl) part.hostedContentUrl = content.hostedContentUrl;
    if (content.hostedExpiresAt) part.hostedExpiresAt = content.hostedExpiresAt;
  }
}

export function messagesFromAgentOutput(input: {
  output: string;
  outputAnsi?: string;
  tool?: string;
}): AgentTranscriptMessage[] {
  const richLines =
    input.outputAnsi && /\x1b\[[0-9;:]*m/.test(input.outputAnsi) ? parseSgrRichTextLines(input.outputAnsi) : undefined;
  return messagesFromParsedAgentOutput(
    parseAgentOutput(input.output, {
      includeSource: Boolean(richLines),
      tool: input.tool,
    }),
    { richLines },
  );
}
