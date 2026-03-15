import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { appendEntry, type ContextEntry } from "./context-file.js";
import { getAimuxDir } from "../config.js";

const git = simpleGit();

/**
 * Capture git diff and write a context entry after a tool session ends or is backgrounded.
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

    const entry: ContextEntry = {
      sessionName,
      tool,
      timestamp: new Date(),
      prompt: "(auto-captured on session exit)",
      response: `Session ended. ${diffStat.files.length} file(s) changed.`,
      files: diffStat.files.map((f: { file: string }) => f.file),
      diff: diff ? diff.slice(0, 2000) : undefined,
    };

    await appendEntry(entry, cwd);
  } catch {
    // Git not available or not a git repo — skip silently
  }
}

/**
 * Get recent stripped output from a session's recording for injection into a new session.
 * Returns the last N lines from the session's .txt recording file.
 */
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
    const recent = lines.slice(-maxLines).join("\n").trim();
    return recent;
  } catch {
    return "";
  }
}

/**
 * Build a context preamble for a new session, summarizing what other sessions have done.
 */
export function buildContextPreamble(
  otherSessionIds: string[],
  maxLinesPerSession: number = 10,
  cwd?: string
): string {
  const sections: string[] = [];

  for (const id of otherSessionIds) {
    const output = getRecentOutput(id, maxLinesPerSession, cwd);
    if (output) {
      sections.push(`--- Recent output from ${id} ---\n${output}`);
    }
  }

  if (sections.length === 0) return "";

  return (
    "=== Context from other aimux sessions ===\n\n" +
    sections.join("\n\n") +
    "\n\n=== End context ===\n"
  );
}
