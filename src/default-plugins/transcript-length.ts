import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readHistory } from "../context/history.js";
import { getContextDir } from "../paths.js";
import type { AimuxPluginAPI, AimuxPluginInstance } from "../plugin-runtime.js";

interface TranscriptLengthPluginOptions {
  line: "top" | "bottom";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 102.4) / 10)}kb`;
  return `${Math.max(1, Math.round(bytes / 104857.6) / 10)}mb`;
}

function readLastCompactionTurnTs(sessionId: string): string | undefined {
  const checkpointsPath = join(getContextDir(), sessionId, "summary.checkpoints.jsonl");
  if (!existsSync(checkpointsPath)) return undefined;
  try {
    const lines = readFileSync(checkpointsPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const last = lines.at(-1);
    if (!last) return undefined;
    const parsed = JSON.parse(last) as { lastTurnTs?: string };
    return parsed.lastTurnTs;
  } catch {
    return undefined;
  }
}

function transcriptBytesSinceCheckpoint(sessionId: string): number {
  const lastTurnTs = readLastCompactionTurnTs(sessionId);
  const turns = readHistory(sessionId, lastTurnTs ? { since: lastTurnTs } : undefined).filter(
    (turn) => !lastTurnTs || turn.ts > lastTurnTs,
  );
  return turns.reduce((total, turn) => total + Buffer.byteLength(`${JSON.stringify(turn)}\n`), 0);
}

function buildSegmentText(sessionId: string): string | null {
  const bytes = transcriptBytesSinceCheckpoint(sessionId);
  return formatBytes(bytes);
}

export function createTranscriptLengthPlugin(
  api: AimuxPluginAPI,
  options: TranscriptLengthPluginOptions,
): AimuxPluginInstance {
  const lastRendered = new Map<string, string>();
  let timer: NodeJS.Timeout | null = null;

  const sync = () => {
    const sessions = api.sessions.list();
    const liveIds = new Set(sessions.map((session) => session.id));
    for (const sessionId of [...lastRendered.keys()]) {
      if (liveIds.has(sessionId)) continue;
      api.metadata.clearStatuslineSegment(sessionId, "transcript-length");
      lastRendered.delete(sessionId);
    }

    for (const session of sessions) {
      const text = buildSegmentText(session.id);
      const previous = lastRendered.get(session.id);
      if (!text) {
        if (previous !== undefined) {
          api.metadata.clearStatuslineSegment(session.id, "transcript-length");
          lastRendered.delete(session.id);
        }
        continue;
      }
      if (previous === text) continue;
      api.metadata.setStatuslineSegment(session.id, options.line, {
        id: "transcript-length",
        text,
        tone: "neutral",
      });
      lastRendered.set(session.id, text);
    }
  };

  return {
    start() {
      sync();
      timer = setInterval(sync, 2_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
