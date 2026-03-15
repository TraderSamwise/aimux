import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { appendEntry, type ContextEntry } from "./context-file.js";
import { getAimuxDir } from "../config.js";

const git = simpleGit();

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
 * Live context watcher. Monitors recording files for new conversation turns
 * and writes context entries + maintains a compact summary for cross-agent sharing.
 */
export class ContextWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessions: Array<{ id: string; command: string }> = [];
  private cwd?: string;
  /** Track how far we've read into each session's recording */
  private readOffsets = new Map<string, number>();
  /** Accumulated turns per session since last compaction */
  private pendingTurns = new Map<string, ConversationTurn[]>();

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
    // Final compaction
    this.compact();
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
      this.extractNewContent(session);
    }
    // Write compact summary
    this.compact();
  }

  /**
   * Read new content from a session's recording since our last read offset.
   * Parse it into conversation turns and queue them.
   */
  private extractNewContent(session: { id: string; command: string }): void {
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

      if (turns.length > 0) {
        const existing = this.pendingTurns.get(session.id) ?? [];
        existing.push(...turns);
        // Keep last 50 turns max
        if (existing.length > 50) existing.splice(0, existing.length - 50);
        this.pendingTurns.set(session.id, existing);
      }
    } catch {}
  }

  /**
   * Write a compact context summary that other agents can read.
   * This is the live-updated file at .aimux/context/live.md
   */
  private compact(): void {
    const dir = join(getAimuxDir(this.cwd), "context");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const sections: string[] = ["# aimux Live Context\n"];
    sections.push(`Updated: ${new Date().toISOString()}\n`);

    for (const session of this.sessions) {
      const turns = this.pendingTurns.get(session.id);
      if (!turns || turns.length === 0) continue;

      sections.push(`## ${session.id} (${session.command})\n`);

      // Include last 10 turns for compactness
      const recent = turns.slice(-10);
      for (const turn of recent) {
        if (turn.type === "prompt") {
          sections.push(`**User:** ${truncate(turn.content, 200)}\n`);
        } else {
          sections.push(`**Agent:** ${truncate(turn.content, 500)}\n`);
        }
      }
      sections.push("---\n");
    }

    if (sections.length > 2) {
      writeFileSync(join(dir, "live.md"), sections.join("\n"));
    }
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
