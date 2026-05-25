import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { getSessionMessagesDir } from "./paths.js";

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
  actor?: {
    userId: string;
    displayName: string;
    email?: string;
    role?: "owner" | "guest";
  };
  shareId?: string;
  chatMode?: "single" | "multi";
}

function historyPath(sessionId: string): string {
  return join(getSessionMessagesDir(), `${sessionId}.jsonl`);
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
