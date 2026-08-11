import { createHash } from "node:crypto";

import { parseAgentOutput } from "./agent-output-parser.js";
import { parseSgrRichTextLines, richTextLineText, sliceRichTextSpans, type RichTextSpan } from "./rich-text.js";

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

export interface AgentTranscriptImagePart {
  type: "image_reference";
  /** Stable within one projection: the same attachment keeps the same label. */
  label: string;
  attachmentId: string;
  filename?: string;
  mimeType?: string;
}

export interface AgentTranscriptTextPart {
  type: "text";
  text: string;
  spans?: RichTextSpan[];
}

export type AgentTranscriptPart = AgentTranscriptTextPart | AgentTranscriptImagePart;

export interface AgentTranscriptMessage {
  /**
   * Derived from content, never position.
   *
   * The pane is a sliding window, so a positional id changes under every
   * message as output scrolls and a client keyed on it rebuilds the whole
   * transcript on each poll.
   */
  id: string;
  role: "user" | "assistant";
  parts: AgentTranscriptPart[];
  /** Plain text, for a client that does not want to walk parts. */
  text: string;
  /**
   * The newest message, which is usually the one being written into.
   *
   * Its content changes on every read, so its content-derived id does too. A
   * client that wants a stable key across polls should key this one by
   * position and everything else by id. It is the last MESSAGE, not the last
   * thing on screen — a trailing status row is not a message — so right after
   * a send it is the prompt, and nothing is being written into it yet.
   */
  latest?: true;
}

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

const ATTACHED_IMAGE_LINE =
  /^\s*-\s+(.+?)\s+\((image\/[^,]+),\s+\d+\s+bytes\):\s+(.+?\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)\.[^\s/]+)\s*$/;
const INLINE_ATTACHED_IMAGE =
  /^(.*?)\s*Attached image files:\s*-\s+(.+?)\s+\((image\/[^,]+),\s+\d+\s+bytes\):\s+(.+?\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)\.[^\s/]+)\s*$/;
const FLATTENED_ATTACHMENTS_HEADER = /\bAttached image files:\s*/;
const FLATTENED_ATTACHMENT_ITEM =
  /-\s+(.+?)\s+\((image\/[^,]+),\s+\d+\s+bytes\):\s+(\S*?\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)\.[^\s/]+)/g;
const VIEWED_IMAGE_PATH =
  /^\s*(?:[└⎿L]\s*)?(?:\.aimux\/attachments\/|.+?\.aimux\/attachments\/)(att_[A-Za-z0-9_-]+)\.[^\s/]+\s*$/;

type ImageLabels = { byId: Map<string, string>; next: number };

function blockType(block: TranscriptBlock): string {
  return String(block.type ?? block.kind ?? "").trim();
}

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").trim();
}

function labelFor(labels: ImageLabels, attachmentId: string): string {
  const existing = labels.byId.get(attachmentId);
  if (existing) return existing;
  const label = `[image #${labels.next}]`;
  labels.next += 1;
  labels.byId.set(attachmentId, label);
  return label;
}

function imagePart(
  labels: ImageLabels,
  attachmentId: string,
  opts: { filename?: string; mimeType?: string } = {},
): AgentTranscriptImagePart {
  return {
    type: "image_reference",
    label: labelFor(labels, attachmentId),
    attachmentId,
    filename: opts.filename,
    mimeType: opts.mimeType,
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
function partsFromFlattened(text: string, labels: ImageLabels): AgentTranscriptPart[] | null {
  if (!text.includes("Attached image files:")) return null;

  const flattened = text.replace(/\s+/g, " ").trim();
  const header = flattened.match(FLATTENED_ATTACHMENTS_HEADER);
  if (header?.index === undefined) return null;

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
    parts.push(imagePart(labels, match[4], { filename: match[1], mimeType: match[2] }));
    cursor = match.index + match[0].length;
    matched = true;
  }

  // Collapsing to a space is not enough when the wrap fell inside the path
  // itself — `.aimux/attach ments/att_…` matches nothing. Observed on a live
  // box. The id survives with the spaces removed entirely; the filename and
  // type do not, and are better dropped than guessed at.
  if (!matched) {
    // Squash to find the ids, but keep a map back to the original so the path
    // can be *removed* exactly rather than guessed at. Leaving it in would put
    // `/srv/…/.aimux/attachments/att_….png` in somebody's chat; dropping the
    // whole tail would eat any words that came after it.
    let squashed = "";
    const sourceIndex: number[] = [];
    for (let i = 0; i < tail.length; i += 1) {
      if (/\s/.test(tail[i]!)) continue;
      squashed += tail[i];
      sourceIndex.push(i);
    }

    const recovered: AgentTranscriptImagePart[] = [];
    const drop = new Set<number>();
    const PATH_CHAR = /[A-Za-z0-9_\-./~]/;

    for (const match of squashed.matchAll(/\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]{1,8})?/g)) {
      if (!match[1] || match.index === undefined) continue;
      recovered.push(imagePart(labels, match[1]));
      // Walk back over the directories that led here, so the whole path goes.
      let from = match.index;
      while (from > 0 && PATH_CHAR.test(squashed[from - 1]!)) from -= 1;
      for (let i = from; i < match.index + match[0].length; i += 1) {
        drop.add(sourceIndex[i]!);
      }
    }

    if (recovered.length === 0) return null;

    const prose = tail
      .split("")
      .filter((_, index) => !drop.has(index))
      .join("")
      // What is left of a list item once its path is gone.
      .replace(/[-•]\s*(?=\s|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (prose) parts.push({ type: "text", text: prose });
    parts.push(...recovered);
    return parts;
  }
  const suffix = tail.slice(cursor).trim();
  if (suffix) parts.push({ type: "text", text: suffix });
  return parts;
}

function partsFromText(text: string, labels: ImageLabels): AgentTranscriptPart[] {
  const flattened = partsFromFlattened(text, labels);
  if (flattened) return flattened;

  const lines = text.split("\n");
  const parts: AgentTranscriptPart[] = [];
  const textLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const inline = line.match(INLINE_ATTACHED_IMAGE);
    if (inline?.[5]) {
      const prefix = inline[1]?.trim();
      if (prefix) textLines.push(prefix);
      flushText(parts, textLines);
      parts.push(
        imagePart(labels, inline[5], {
          filename: inline[2],
          mimeType: inline[3],
        }),
      );
      continue;
    }

    if (/^\s*Attached image files:\s*$/.test(line)) {
      const images: AgentTranscriptImagePart[] = [];
      let next = index + 1;
      while (next < lines.length) {
        const match = (lines[next] ?? "").match(ATTACHED_IMAGE_LINE);
        if (!match) break;
        images.push(
          imagePart(labels, match[4] ?? "", {
            filename: match[1],
            mimeType: match[2],
          }),
        );
        next += 1;
      }
      if (images.length > 0) {
        flushText(parts, textLines);
        parts.push(...images);
        index = next - 1;
        continue;
      }
    }

    if (/^\s*Viewed Image\s*$/i.test(line)) {
      const pathLine = index + 1;
      const match = (lines[pathLine] ?? "").match(VIEWED_IMAGE_PATH);
      if (match?.[1]) {
        flushText(parts, textLines);
        parts.push(imagePart(labels, match[1]));
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
  options: { richLines?: readonly (readonly RichTextSpan[])[] } = {},
): AgentTranscriptMessage[] {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const messages: AgentTranscriptMessage[] = [];
  const labels: ImageLabels = { byId: new Map(), next: 1 };
  // The same words twice is a legitimate conversation — "yes", "yes" — so a
  // repeat is numbered rather than allowed to collide.
  const seen = new Map<string, number>();

  for (const block of blocks) {
    const type = blockType(block);
    if (type !== "prompt" && type !== "response") continue;
    const raw = normalizeText(String(block.text ?? ""));
    if (!raw) continue;

    const role = type === "prompt" ? "user" : "assistant";
    const base = contentId(role, raw);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    const parts = partsFromText(raw, labels);
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
