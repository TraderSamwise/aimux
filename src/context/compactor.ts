import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { getAimuxDir } from "../config.js";
import { readHistory, type HistoryTurn } from "./history.js";

const MAX_SUMMARY_BYTES = 30 * 1024;

const DECISION_KEYWORDS = /\b(decided|chose|instead|approach|switched to|went with)\b/i;
const ERROR_KEYWORDS = /\b(error|failed|blocked|issue|broken|crash|exception)\b/i;

/**
 * Algorithmic compaction: extract key signals from history and write a structured summary.
 */
export function algorithmicCompact(
  sessionIds: string[],
  cwd?: string
): void {
  const dir = join(getAimuxDir(cwd), "context");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sections: string[] = [
    "# aimux Session Summary",
    `Generated: ${new Date().toISOString()}`,
    "",
  ];

  for (const sessionId of sessionIds) {
    const turns = readHistory(sessionId, undefined, cwd);
    if (turns.length === 0) continue;

    const tasks: string[] = [];
    const fileCounts = new Map<string, number>();
    const decisions: string[] = [];
    const errors: string[] = [];

    for (const turn of turns) {
      if (turn.type === "prompt") {
        tasks.push(turn.content);
      }

      if (turn.type === "response") {
        // Extract key decisions and errors from response lines
        for (const line of turn.content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (DECISION_KEYWORDS.test(trimmed)) {
            decisions.push(trimmed);
          }
          if (ERROR_KEYWORDS.test(trimmed)) {
            errors.push(trimmed);
          }
        }
      }

      // Count file modifications from response and git turns
      if (turn.files) {
        for (const file of turn.files) {
          fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
        }
      }
    }

    sections.push(`## ${sessionId} — ${turns.length} turns`);
    sections.push("");

    // Key tasks (deduplicated, truncated)
    if (tasks.length > 0) {
      sections.push("### Key tasks");
      const uniqueTasks = [...new Set(tasks)];
      for (const task of uniqueTasks.slice(-20)) {
        sections.push(`- ${truncate(task, 150)}`);
      }
      sections.push("");
    }

    // Files modified
    if (fileCounts.size > 0) {
      sections.push("### Files modified");
      const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [file, count] of sorted) {
        sections.push(`- ${file} (${count} time${count > 1 ? "s" : ""})`);
      }
      sections.push("");
    }

    // Key decisions
    if (decisions.length > 0) {
      sections.push("### Key decisions");
      for (const d of decisions.slice(-10)) {
        sections.push(`- ${truncate(d, 200)}`);
      }
      sections.push("");
    }

    // Errors/blockers
    if (errors.length > 0) {
      sections.push("### Errors & blockers");
      for (const e of errors.slice(-10)) {
        sections.push(`- ${truncate(e, 200)}`);
      }
      sections.push("");
    }

    sections.push("---");
    sections.push("");
  }

  let content = sections.join("\n");

  // Enforce size limit: trim oldest session sections if too large
  while (content.length > MAX_SUMMARY_BYTES) {
    const firstSessionIdx = content.indexOf("\n## ", content.indexOf("\n## ") + 1);
    if (firstSessionIdx === -1) break;
    const headerEnd = content.indexOf("\n## ", 4); // find first session section
    if (headerEnd === -1) break;
    // Remove the first session section (between first ## and second ##)
    const secondSection = content.indexOf("\n## ", headerEnd + 1);
    if (secondSection === -1) {
      // Only one section left, truncate content
      content = content.slice(0, MAX_SUMMARY_BYTES);
      break;
    }
    content = content.slice(0, headerEnd) + content.slice(secondSection);
  }

  writeFileSync(join(dir, "summary.md"), content);
}

/**
 * LLM-powered compaction: send history to claude for summarization.
 */
export function llmCompact(
  sessionIds: string[],
  cwd?: string
): void {
  const dir = join(getAimuxDir(cwd), "context");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Build conversation history text
  const historyParts: string[] = [];

  for (const sessionId of sessionIds) {
    const turns = readHistory(sessionId, { lastN: 200 }, cwd);
    if (turns.length === 0) continue;

    historyParts.push(`=== Session: ${sessionId} (${turns.length} turns) ===`);
    for (const turn of turns) {
      const time = turn.ts.slice(11, 16);
      if (turn.type === "prompt") {
        historyParts.push(`[${time}] User: ${turn.content}`);
      } else if (turn.type === "response") {
        historyParts.push(`[${time}] Agent: ${truncate(turn.content, 1000)}`);
        if (turn.files && turn.files.length > 0) {
          historyParts.push(`  Files: ${turn.files.join(", ")}`);
        }
      } else if (turn.type === "git") {
        historyParts.push(`[${time}] Git: ${turn.content}`);
        if (turn.files) {
          historyParts.push(`  Files: ${turn.files.join(", ")}`);
        }
      }
    }
    historyParts.push("");
  }

  const history = historyParts.join("\n");
  if (!history.trim()) return;

  const prompt =
    "Summarize the following aimux agent session history. " +
    "For each session, list: key tasks completed, files modified, " +
    "important decisions made, and any errors or blockers encountered. " +
    "Be concise but thorough. Output markdown.\n\n" +
    history;

  try {
    const output = execSync("claude --print --output-format text", {
      input: prompt,
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    let summary = `# aimux Session Summary\nGenerated: ${new Date().toISOString()}\nSource: LLM compaction\n\n${output}`;

    // Enforce size limit
    if (summary.length > MAX_SUMMARY_BYTES) {
      summary = summary.slice(0, MAX_SUMMARY_BYTES);
    }

    writeFileSync(join(dir, "summary.md"), summary);
  } catch {
    // If claude CLI fails, fall back to algorithmic
    algorithmicCompact(sessionIds, cwd);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}
