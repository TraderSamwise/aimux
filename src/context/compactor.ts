import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.js";
import { getContextDir } from "../paths.js";
import { readHistory } from "./history.js";

const MAX_SUMMARY_BYTES = 30 * 1024;

const DECISION_KEYWORDS = /\b(decided|chose|instead|approach|switched to|went with)\b/i;
const ERROR_KEYWORDS = /\b(error|failed|blocked|issue|broken|crash|exception)\b/i;

export interface SummaryProvenance {
  sessionId: string;
  mode: "algorithmic" | "llm";
  generatedAt: string;
  turns: number;
  firstTurnTs?: string;
  lastTurnTs?: string;
  historyDigest: string;
  summaryBytes: number;
}

function historyDigest(turns: ReturnType<typeof readHistory>): string {
  const hash = createHash("sha1");
  for (const turn of turns) {
    hash.update(turn.ts);
    hash.update("\0");
    hash.update(turn.type);
    hash.update("\0");
    hash.update(turn.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function withSummaryHeader(summary: string, provenance: SummaryProvenance): string {
  const lines = [
    `# ${provenance.sessionId} — Session Summary`,
    `Generated: ${provenance.generatedAt}`,
    `Source: ${provenance.mode}`,
    `Turns covered: ${provenance.turns}`,
  ];
  if (provenance.firstTurnTs || provenance.lastTurnTs) {
    lines.push(`History range: ${provenance.firstTurnTs ?? "unknown"} -> ${provenance.lastTurnTs ?? "unknown"}`);
  }
  lines.push(`History digest: ${provenance.historyDigest}`);
  lines.push("");
  return `${lines.join("\n")}${summary.trimStart() ? `\n${summary.trimStart()}` : ""}`;
}

function writeSummaryArtifacts(
  sessionDir: string,
  sessionId: string,
  mode: SummaryProvenance["mode"],
  turns: ReturnType<typeof readHistory>,
  summary: string,
): void {
  const generatedAt = new Date().toISOString();
  const baseProvenance: SummaryProvenance = {
    sessionId,
    mode,
    generatedAt,
    turns: turns.length,
    firstTurnTs: turns[0]?.ts,
    lastTurnTs: turns.at(-1)?.ts,
    historyDigest: historyDigest(turns),
    summaryBytes: 0,
  };
  const summaryWithHeader = withSummaryHeader(summary, baseProvenance);
  const provenance: SummaryProvenance = {
    ...baseProvenance,
    summaryBytes: Buffer.byteLength(summaryWithHeader),
  };

  writeFileSync(join(sessionDir, "summary.md"), summaryWithHeader);
  writeFileSync(join(sessionDir, "summary.meta.json"), JSON.stringify(provenance, null, 2) + "\n");
  appendFileSync(join(sessionDir, "summary.checkpoints.jsonl"), JSON.stringify(provenance) + "\n");
}

/**
 * Algorithmic compaction: extract key signals from history and write per-session summaries.
 * Each session gets its own context/{session-id}/summary.md.
 */
export function algorithmicCompact(sessionIds: string[]): void {
  const baseDir = getContextDir();
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });

  for (const sessionId of sessionIds) {
    const turns = readHistory(sessionId);
    if (turns.length === 0) continue;

    const sessionDir = join(baseDir, sessionId);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

    const sections: string[] = [];

    const tasks: string[] = [];
    const fileCounts = new Map<string, number>();
    const decisions: string[] = [];
    const errors: string[] = [];

    for (const turn of turns) {
      if (turn.type === "prompt") {
        tasks.push(turn.content);
      }

      if (turn.type === "response") {
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

      if (turn.files) {
        for (const file of turn.files) {
          fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
        }
      }
    }

    sections.push(`${turns.length} turns`);
    sections.push("");

    if (tasks.length > 0) {
      sections.push("### Key tasks");
      const uniqueTasks = [...new Set(tasks)];
      for (const task of uniqueTasks.slice(-20)) {
        sections.push(`- ${truncate(task, 150)}`);
      }
      sections.push("");
    }

    if (fileCounts.size > 0) {
      sections.push("### Files modified");
      const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [file, count] of sorted) {
        sections.push(`- ${file} (${count} time${count > 1 ? "s" : ""})`);
      }
      sections.push("");
    }

    if (decisions.length > 0) {
      sections.push("### Key decisions");
      for (const d of decisions.slice(-10)) {
        sections.push(`- ${truncate(d, 200)}`);
      }
      sections.push("");
    }

    if (errors.length > 0) {
      sections.push("### Errors & blockers");
      for (const e of errors.slice(-10)) {
        sections.push(`- ${truncate(e, 200)}`);
      }
      sections.push("");
    }

    let content = sections.join("\n");

    // Enforce size limit
    if (content.length > MAX_SUMMARY_BYTES) {
      content = content.slice(0, MAX_SUMMARY_BYTES);
    }

    writeSummaryArtifacts(sessionDir, sessionId, "algorithmic", turns, content);
  }
}

/**
 * LLM-powered compaction: send each session's history to claude for summarization.
 * Each session gets its own context/{session-id}/summary.md.
 */
export function llmCompact(sessionIds: string[]): void {
  const baseDir = getContextDir();
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });

  for (const sessionId of sessionIds) {
    const turns = readHistory(sessionId, { lastN: 200 });
    if (turns.length === 0) continue;

    const sessionDir = join(baseDir, sessionId);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

    const historyParts: string[] = [];
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

    const history = historyParts.join("\n");
    if (!history.trim()) continue;

    const prompt =
      "Summarize the following agent session history. " +
      "List: key tasks completed, files modified, " +
      "important decisions made, and any errors or blockers encountered. " +
      "Be concise but thorough. Output markdown.\n\n" +
      history;

    try {
      // Find compactCommand from any tool that has one configured
      const config = loadConfig();
      const compactCmd =
        Object.values(config.tools).find((t) => t.compactCommand)?.compactCommand ??
        "claude --print --output-format text";
      const output = execSync(compactCmd, {
        input: prompt,
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });

      let summary = output;

      if (summary.length > MAX_SUMMARY_BYTES) {
        summary = summary.slice(0, MAX_SUMMARY_BYTES);
      }

      writeSummaryArtifacts(sessionDir, sessionId, "llm", turns, summary);
    } catch {
      // If claude CLI fails for this session, fall back to algorithmic for just this session
      algorithmicCompact([sessionId]);
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}
