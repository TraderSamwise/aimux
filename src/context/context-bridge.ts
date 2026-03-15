import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { appendEntry, type ContextEntry } from "./context-file.js";
import { getAimuxDir, loadConfig } from "../config.js";
import { appendTurn, readHistory, type HistoryTurn } from "./history.js";
import { algorithmicCompact } from "./compactor.js";
import { debug, debugTurn, debugGit, debugContext, debugCompact } from "../debug.js";

const git = simpleGit();

const MAX_LIVE_MD_BYTES = 50 * 1024;

/**
 * Capture git diff and write a context entry on session exit.
 */
export async function captureGitContext(
  sessionName: string,
  tool: string,
  cwd?: string
): Promise<void> {
  try {
    const diff = await git.diff();
    const diffStat = await git.diffSummary();
    if (diffStat.files.length === 0 && !diff) return;

    const recentOutput = getRecentOutput(sessionName, 30, cwd);

    const entry: ContextEntry = {
      sessionName,
      tool,
      timestamp: new Date(),
      prompt: "(session exit)",
      response: recentOutput || `Session ended. ${diffStat.files.length} file(s) changed.`,
      files: diffStat.files.map((f: { file: string }) => f.file),
      diff: diff ? diff.slice(0, 2000) : undefined,
    };

    await appendEntry(entry, cwd);
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
  private sessions: Array<{ id: string; command: string }> = [];
  private cwd?: string;
  /** Track how far we've read into each session's recording */
  private readOffsets = new Map<string, number>();
  /** Track last turn type per session to detect response→prompt transitions */
  private lastTurnTypes = new Map<string, "prompt" | "response">();
  /** Hash of last git diff output for change detection */
  private lastDiffHash = "";
  /** Total turn count across all sessions, for compaction trigger */
  private totalTurnCount = 0;
  private dirty = false;

  constructor(cwd?: string) {
    this.cwd = cwd;
  }

  updateSessions(sessions: Array<{ id: string; command: string }>): void {
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
    // Final live context write
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
    return join(getAimuxDir(this.cwd), "recordings", `${sessionId}.txt`);
  }

  private async tick(): Promise<void> {
    for (const session of this.sessions) {
      if (!this.readOffsets.has(session.id)) {
        this.initOffset(session.id);
      }
      await this.extractNewContent(session);
    }
    // Only write live context when new turns were extracted
    if (this.dirty) {
      this.dirty = false;
      this.writeLiveContext();
    }
  }

  /**
   * Read new content from a session's recording since our last read offset.
   * Parse into turns and persist to JSONL history.
   */
  private async extractNewContent(session: { id: string; command: string }): Promise<void> {
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
      const turns = parseConversationTurns(newContent, session.command);

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
        appendTurn(session.id, historyTurn, this.cwd);
        this.totalTurnCount++;
        this.dirty = true;
        this.lastTurnTypes.set(session.id, turn.type);
        debugTurn(session.id, turn.type, turn.content.length);

        // Trigger algorithmic compaction periodically
        const compactEvery = loadConfig(this.cwd).compactEveryNTurns;
        if (this.totalTurnCount > 0 && this.totalTurnCount % compactEvery === 0) {
          const sessionIds = this.sessions.map((s) => s.id);
          debugCompact(sessionIds.length, this.totalTurnCount);
          algorithmicCompact(sessionIds, this.cwd);
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
      appendTurn(sessionId, gitTurn, this.cwd);
    } catch {}
  }

  /**
   * Write live context from history JSONL files.
   * Sources from readHistory() instead of in-memory state.
   */
  private writeLiveContext(): void {
    const dir = join(getAimuxDir(this.cwd), "context");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let turnsPerSession = loadConfig(this.cwd).liveWindowSize;

    // Try building content, reduce turns if it exceeds size limit
    while (turnsPerSession >= 2) {
      const content = this.buildLiveContent(turnsPerSession);
      if (content.length <= MAX_LIVE_MD_BYTES || turnsPerSession <= 2) {
        if (content.length > 2) {
          const livePath = join(dir, "live.md");
          writeFileSync(livePath, content);
          debugContext("wrote", "live.md", content.length);
        }
        return;
      }
      turnsPerSession = Math.floor(turnsPerSession * 0.7);
    }
  }

  /**
   * Build the live.md content string from history files.
   */
  private buildLiveContent(turnsPerSession: number): string {
    const sections: string[] = ["# aimux Live Context\n"];
    sections.push(`Updated: ${new Date().toISOString()}\n`);

    for (const session of this.sessions) {
      const turns = readHistory(session.id, { lastN: turnsPerSession }, this.cwd);
      if (turns.length === 0) continue;

      sections.push(`## ${session.id} (${session.command})\n`);

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
      sections.push("---\n");
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
function parseConversationTurns(text: string, tool: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const lines = text.split("\n");

  // Prompt patterns by tool
  const promptPatterns: Record<string, RegExp[]> = {
    claude: [/^[❯>]\s*(.+)/, /^❯\s*$/],
    codex: [/^[>❯]\s*(.+)/],
    aider: [/^aider>\s*(.+)/, /^>\s*(.+)/],
  };

  const patterns = promptPatterns[tool] ?? [/^[>❯$]\s*(.+)/];

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
        promptContent = match[1] ?? trimmed;
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
export function getRecentOutput(
  sessionId: string,
  maxLines: number = 20,
  cwd?: string
): string {
  const txtPath = join(getAimuxDir(cwd), "recordings", `${sessionId}.txt`);
  if (!existsSync(txtPath)) return "";

  try {
    const content = readFileSync(txtPath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(-maxLines).join("\n").trim();
  } catch {
    return "";
  }
}

/** Build a context preamble for a new session. */
export function buildContextPreamble(
  otherSessionIds: string[],
  maxLinesPerSession: number = 10,
  cwd?: string
): string {
  // Try live context first
  const livePath = join(getAimuxDir(cwd), "context", "live.md");
  if (existsSync(livePath)) {
    try {
      return readFileSync(livePath, "utf-8");
    } catch {}
  }

  // Fallback to recording snippets
  const sections: string[] = [];
  for (const id of otherSessionIds) {
    const output = getRecentOutput(id, maxLinesPerSession, cwd);
    if (output) {
      sections.push(`--- Recent output from ${id} ---\n${output}`);
    }
  }
  if (sections.length === 0) return "";
  return "=== Context from other aimux sessions ===\n\n" +
    sections.join("\n\n") + "\n\n=== End context ===\n";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}
