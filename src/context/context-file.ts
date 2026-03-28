import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";
import { getContextDir, getContextPathForDate } from "../paths.js";

export interface ContextEntry {
  sessionName: string;
  tool: string;
  timestamp: Date;
  prompt: string;
  response: string;
  files: string[];
  diff?: string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}

function formatEntry(entry: ContextEntry): string {
  const time = entry.timestamp.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const lines: string[] = [
    `### [${time}] ${entry.sessionName} (${entry.tool})`,
    `<!-- aimux:entry session=${entry.sessionName} tool=${entry.tool} ts=${entry.timestamp.toISOString()} -->`,
    "",
    `**Prompt:** ${entry.prompt}`,
    "",
    `**Response:**`,
    truncate(entry.response.trim(), 1000),
    "",
  ];

  if (entry.files.length > 0) {
    lines.push("**Files changed:**");
    for (const f of entry.files) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  if (entry.diff) {
    lines.push("<details><summary>Diff</summary>", "", "```diff");
    lines.push(entry.diff);
    lines.push("```", "", "</details>");
    lines.push("");
  }

  lines.push("---", "");

  return lines.join("\n");
}

function ensureDayFile(filePath: string, date: Date): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(filePath)) {
    const dateStr = date.toISOString().split("T")[0];
    writeFileSync(filePath, `# aimux Context — ${dateStr}\n\n`);
  }
}

export async function appendEntry(entry: ContextEntry): Promise<void> {
  const now = entry.timestamp;
  const filePath = getContextPathForDate(now);
  ensureDayFile(filePath, now);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, {
      retries: { retries: 5, minTimeout: 50 },
    });

    const existing = readFileSync(filePath, "utf-8");
    const newContent = existing + formatEntry(entry);
    writeFileSync(filePath, newContent);
  } finally {
    if (release) await release();
  }
}

export function readContext(maxEntries: number = 20): string {
  const contextDir = getContextDir();
  if (!existsSync(contextDir)) return "";

  const files = readdirSync(contextDir)
    .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
    .sort()
    .reverse();

  if (files.length === 0) return "";

  const allEntries: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(contextDir, file), "utf-8");
    const entries = content.split(/(?=### \[)/).filter((e) => e.startsWith("### ["));
    allEntries.push(...entries.reverse());

    if (allEntries.length >= maxEntries) break;
  }

  const selected = allEntries.slice(0, maxEntries).reverse();

  if (selected.length === 0) return "";

  return selected.join("");
}
