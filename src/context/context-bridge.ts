import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { appendEntry, type ContextEntry } from "./context-file.js";
import { loadConfig } from "../config.js";
import { getRecordingsDir, getContextDir } from "../paths.js";
import { appendTurn, readHistory, type HistoryTurn } from "./history.js";
import { algorithmicCompact } from "./compactor.js";
import { debugTurn, debugGit, debugContext, debugCompact } from "../debug.js";

const git = simpleGit();

const MAX_LIVE_MD_BYTES = 50 * 1024;

/**
 * Capture git diff and write a context entry on session exit.
 */
export async function captureGitContext(sessionName: string, tool: string): Promise<void> {
  try {
    const diff = await git.diff();
    const diffStat = await git.diffSummary();
    if (diffStat.files.length === 0 && !diff) return;

    const recentOutput = getRecentOutput(sessionName, 30);

    const entry: ContextEntry = {
      sessionName,
      tool,
      timestamp: new Date(),
      prompt: "(session exit)",
      response: recentOutput || `Session ended. ${diffStat.files.length} file(s) changed.`,
      files: diffStat.files.map((f: { file: string }) => f.file),
      diff: diff ? diff.slice(0, 2000) : undefined,
    };

    await appendEntry(entry);
  } catch {}
}

/**
 * Simple string hash for change detection.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return hash.toString(36);
}

/**
 * Live context watcher. Monitors recording files for new conversation turns,
 * persists them to JSONL history, and maintains live.md for cross-agent sharing.
 */
export class ContextWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessions: Array<{ id: string; command: string; turnPatterns?: RegExp[] }> = [];
  /** Track how far we've read into each session's recording */
  private readOffsets = new Map<string, number>();
  /** Track last turn type per session to detect response→prompt transitions */
  private lastTurnTypes = new Map<string, "prompt" | "response">();
  /** Hash of last git diff output for change detection */
  private lastDiffHash = "";
  /** Total turn count across all sessions, for compaction trigger */
  private totalTurnCount = 0;
  /** Track which sessions have new turns since last write */
  private dirtySessions = new Set<string>();

  updateSessions(sessions: Array<{ id: string; command: string; turnPatterns?: RegExp[] }>): void {
    this.sessions = sessions;
  }

  start(intervalMs = 5_000): void {
    if (this.interval) return;
    // Initialize read offsets to current file sizes (don't process existing content)
    for (const session of this.sessions) {
      this.initOffset(session.id);
    }
    this.interval = setInterval(() => this.tick().catch(() => {}), intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Mark all sessions dirty for final write
    for (const session of this.sessions) {
      this.dirtySessions.add(session.id);
    }
    this.writeLiveContext();
  }

  private initOffset(sessionId: string): void {
    const txtPath = this.recordingPath(sessionId);
    try {
      const stat = statSync(txtPath);
      this.readOffsets.set(sessionId, stat.size);
    } catch {
      this.readOffsets.set(sessionId, 0);
    }
  }

  private recordingPath(sessionId: string): string {
    return join(getRecordingsDir(), `${sessionId}.txt`);
  }

  private async tick(): Promise<void> {
    for (const session of this.sessions) {
      if (!this.readOffsets.has(session.id)) {
        this.initOffset(session.id);
      }
      await this.extractNewContent(session);
    }
    // Only write live context when new turns were extracted
    if (this.dirtySessions.size > 0) {
      this.writeLiveContext();
    }
  }

  /**
   * Read new content from a session's recording since our last read offset.
   * Parse into turns and persist to JSONL history.
   */
  private async extractNewContent(session: { id: string; command: string; turnPatterns?: RegExp[] }): Promise<void> {
    const txtPath = this.recordingPath(session.id);
    if (!existsSync(txtPath)) return;

    try {
      const content = readFileSync(txtPath, "utf-8");
      const offset = this.readOffsets.get(session.id) ?? 0;

      if (content.length <= offset) return;

      const newContent = content.slice(offset);
      this.readOffsets.set(session.id, content.length);

      // Skip if just whitespace/control chars
      const trimmed = newContent.replace(/[\s\r\n]/g, "");
      if (trimmed.length < 10) return;

      // Parse new content into turns
      const turns = parseConversationTurns(newContent, session.command, session.turnPatterns);

      for (const turn of turns) {
        const prevType = this.lastTurnTypes.get(session.id);

        // When a prompt appears after a response, the agent finished — check git diff
        if (turn.type === "prompt" && prevType === "response") {
          await this.captureGitDiff(session.id);
        }

        // Persist to JSONL
        const historyTurn: HistoryTurn = {
          ts: new Date().toISOString(),
          type: turn.type,
          content: turn.content,
        };
        appendTurn(session.id, historyTurn);
        this.totalTurnCount++;
        this.dirtySessions.add(session.id);
        this.lastTurnTypes.set(session.id, turn.type);
        debugTurn(session.id, turn.type, turn.content.length);

        // Trigger algorithmic compaction periodically
        const compactEvery = loadConfig().compactEveryNTurns;
        if (this.totalTurnCount > 0 && this.totalTurnCount % compactEvery === 0) {
          const sessionIds = this.sessions.map((s) => s.id);
          debugCompact(sessionIds.length, this.totalTurnCount);
          algorithmicCompact(sessionIds);
        }
      }
    } catch {}
  }

  /**
   * Check for git changes and append a git turn to history if files changed.
   */
  private async captureGitDiff(sessionId: string): Promise<void> {
    try {
      const diff = await git.diff();
      const hash = simpleHash(diff || "");

      if (hash === this.lastDiffHash) return;
      this.lastDiffHash = hash;

      if (!diff) return;

      const diffStat = await git.diffSummary();
      if (diffStat.files.length === 0) return;

      const gitTurn: HistoryTurn = {
        ts: new Date().toISOString(),
        type: "git",
        content: `${diffStat.files.length} file(s) changed`,
        files: diffStat.files.map((f: { file: string }) => f.file),
        diff: diff.slice(0, 2000),
      };
      debugGit(diffStat.files.length, diff.length);
      appendTurn(sessionId, gitTurn);
    } catch {}
  }

  /**
   * Write per-session live context from history JSONL files.
   * Each session gets its own context/{session-id}/live.md.
   */
  private writeLiveContext(): void {
    const baseDir = getContextDir();
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });

    const turnsPerSession = loadConfig().liveWindowSize;
    const sessionsToWrite = this.sessions.filter((s) => this.dirtySessions.has(s.id));
    this.dirtySessions.clear();

    for (const session of sessionsToWrite) {
      const sessionDir = join(baseDir, session.id);
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

      let windowSize = turnsPerSession;
      while (windowSize >= 2) {
        const content = this.buildSessionLiveContent(session, windowSize);
        if (content.length <= MAX_LIVE_MD_BYTES || windowSize <= 2) {
          if (content.length > 2) {
            const livePath = join(sessionDir, "live.md");
            writeFileSync(livePath, content);
            debugContext("wrote", `${session.id}/live.md`, content.length);
          }
          break;
        }
        windowSize = Math.floor(windowSize * 0.7);
      }
    }
  }

  /**
   * Build live.md content for a single session from its history.
   */
  private buildSessionLiveContent(session: { id: string; command: string }, turnsPerSession: number): string {
    const turns = readHistory(session.id, { lastN: turnsPerSession });
    if (turns.length === 0) return "";

    const sections: string[] = [`# ${session.id} (${session.command}) — Live Context\n`];
    sections.push(`Updated: ${new Date().toISOString()}\n`);

    for (const turn of turns) {
      const time = turn.ts.slice(11, 16); // HH:MM from ISO string

      if (turn.type === "prompt") {
        sections.push(`**[${time}] User:** ${truncate(turn.content, 200)}\n`);
      } else if (turn.type === "response") {
        sections.push(`**[${time}] Agent:** ${truncate(turn.content, 500)}\n`);
        if (turn.files && turn.files.length > 0) {
          sections.push(`  *Files: ${turn.files.join(", ")}*\n`);
        }
      } else if (turn.type === "git") {
        if (turn.files && turn.files.length > 0) {
          sections.push(`  *Files changed: ${turn.files.join(", ")}*\n`);
        }
      }
    }

    return sections.join("\n");
  }
}

interface ConversationTurn {
  type: "prompt" | "response";
  content: string;
}

/**
 * Parse raw terminal recording output into conversation turns.
 * Uses heuristics based on common CLI tool patterns.
 */
function parseConversationTurns(text: string, tool: string, turnPatterns?: RegExp[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const lines = text.split("\n");

  const patterns = turnPatterns ?? [/^[>❯$]\s*(.+)/];

  let currentType: "prompt" | "response" | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if this line is a prompt
    let isPrompt = false;
    let promptContent = "";
    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        isPrompt = true;
        // Use captured group if present; skip if no capture (bare prompt marker)
        promptContent = match[1]?.trim() ?? "";
        break;
      }
    }

    if (isPrompt && promptContent) {
      // Save previous turn
      if (currentType && currentContent.length > 0) {
        turns.push({
          type: currentType,
          content: currentContent.join("\n").trim(),
        });
      }
      currentType = "prompt";
      currentContent = [promptContent];
    } else if (currentType === "prompt" && !isPrompt) {
      // Transition from prompt to response
      if (currentContent.length > 0) {
        turns.push({
          type: "prompt",
          content: currentContent.join("\n").trim(),
        });
      }
      currentType = "response";
      currentContent = [trimmed];
    } else if (currentType === "response") {
      currentContent.push(trimmed);
    }
  }

  // Save last turn
  if (currentType && currentContent.length > 0) {
    turns.push({
      type: currentType,
      content: currentContent.join("\n").trim(),
    });
  }

  return turns;
}

/** Get recent stripped output from a session's recording. */
export function getRecentOutput(sessionId: string, maxLines: number = 20): string {
  const txtPath = join(getRecordingsDir(), `${sessionId}.txt`);
  if (!existsSync(txtPath)) return "";

  try {
    const content = readFileSync(txtPath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(-maxLines).join("\n").trim();
  } catch {
    return "";
  }
}

/** Build a context preamble for a new session from other sessions' per-session context files. */
export function buildContextPreamble(otherSessionIds: string[], maxLinesPerSession: number = 10): string {
  const contextDir = getContextDir();
  const sections: string[] = [];

  for (const id of otherSessionIds) {
    // Try per-session live.md first
    const sessionLivePath = join(contextDir, id, "live.md");
    if (existsSync(sessionLivePath)) {
      try {
        const content = readFileSync(sessionLivePath, "utf-8");
        if (content.trim()) {
          sections.push(content);
          continue;
        }
      } catch {}
    }
    // Fallback to recording snippets
    const output = getRecentOutput(id, maxLinesPerSession);
    if (output) {
      sections.push(`--- Recent output from ${id} ---\n${output}`);
    }
  }

  if (sections.length === 0) return "";
  return "=== Context from other aimux sessions ===\n\n" + sections.join("\n\n") + "\n\n=== End context ===\n";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}
