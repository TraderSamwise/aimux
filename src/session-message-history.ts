import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionMessagesDir } from "./paths.js";
import type { AgentInputPart } from "./agent-message-parts.js";
import { getAttachment } from "./attachment-store.js";

export interface SessionMessagePart {
  type: "text" | "image";
  text?: string;
  attachmentId?: string;
  alt?: string;
  filename?: string;
  mimeType?: string;
  contentUrl?: string;
}

export interface SessionMessageRecord {
  id: string;
  clientMessageId?: string;
  sessionId: string;
  role: "user";
  ts: string;
  parts: SessionMessagePart[];
}

function historyPath(sessionId: string): string {
  return join(getSessionMessagesDir(), `${sessionId}.jsonl`);
}

export function appendSessionMessage(
  sessionId: string,
  input: {
    data?: string;
    parts?: AgentInputPart[];
    clientMessageId?: string;
  },
): SessionMessageRecord | null {
  const parts = normalizeMessageParts(input);
  if (parts.length === 0) return null;
  const dir = getSessionMessagesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const record: SessionMessageRecord = {
    id: `msg_${randomUUID()}`,
    clientMessageId: input.clientMessageId?.trim() || undefined,
    sessionId,
    role: "user",
    ts: new Date().toISOString(),
    parts,
  };
  appendFileSync(historyPath(sessionId), `${JSON.stringify(record)}\n`);
  return record;
}

export function readSessionMessages(
  sessionId: string,
  opts?: { lastN?: number; maxBytes?: number },
): SessionMessageRecord[] {
  const filePath = historyPath(sessionId);
  if (!existsSync(filePath)) return [];
  const maxBytes = opts?.maxBytes ?? 100 * 1024;

  let raw: string;
  try {
    const size = statSync(filePath).size;
    if (size <= maxBytes) {
      raw = readFileSync(filePath, "utf-8");
    } else {
      const buf = Buffer.alloc(maxBytes);
      const fd = openSync(filePath, "r");
      try {
        readSync(fd, buf, 0, maxBytes, size - maxBytes);
      } finally {
        closeSync(fd);
      }
      raw = buf.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      if (firstNewline !== -1) {
        raw = raw.slice(firstNewline + 1);
      }
    }
  } catch {
    return [];
  }

  let records = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionMessageRecord];
      } catch {
        return [];
      }
    });

  if (opts?.lastN !== undefined && records.length > opts.lastN) {
    records = records.slice(-opts.lastN);
  }
  return records;
}

function normalizeMessageParts(input: { data?: string; parts?: AgentInputPart[] }): SessionMessagePart[] {
  const parts = Array.isArray(input.parts) ? input.parts : [];
  if (parts.length === 0) {
    const text = String(input.data ?? "");
    return text.trim() ? [{ type: "text", text }] : [];
  }

  const normalized: SessionMessagePart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const text = String(part.text ?? "");
      if (text.trim()) {
        normalized.push({ type: "text", text });
      }
      continue;
    }

    const attachmentId = part.attachmentId?.trim();
    if (!attachmentId) continue;
    const attachment = getAttachment(attachmentId);
    normalized.push({
      type: "image",
      attachmentId,
      alt: part.alt?.trim() || undefined,
      filename: attachment?.filename,
      mimeType: attachment?.mimeType,
      contentUrl: attachment?.contentUrl,
    });
  }
  return normalized;
}
