import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPlansDir } from "../paths.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

export function validatePlanSessionId(raw: string): { ok: true; value: string } | { ok: false } {
  if (!SESSION_ID_PATTERN.test(raw)) return { ok: false };
  if (raw.includes("..")) return { ok: false };
  return { ok: true, value: raw };
}

export function getPlanAuthorityDir(): string {
  return getPlansDir();
}

export function getPlanAuthorityDirForLocalAimuxDir(localAimuxDir: string): string {
  return join(localAimuxDir, "plans");
}

export function getPlanAuthorityPath(sessionId: string): string {
  const validation = validatePlanSessionId(sessionId);
  if (!validation.ok) throw new Error("invalid sessionId");
  return join(getPlanAuthorityDir(), `${validation.value}.md`);
}

export function readPlanContent(sessionId: string): string | null {
  try {
    return readFileSync(getPlanAuthorityPath(sessionId), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function listPlanAuthorityEntries(): Array<{ sessionId: string; content: string }> {
  const dir = getPlanAuthorityDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((file) => {
    if (!file.endsWith(".md")) return [];
    const sessionId = file.slice(0, -".md".length);
    if (!validatePlanSessionId(sessionId).ok) return [];
    const content = readPlanContent(sessionId);
    return content === null ? [] : [{ sessionId, content }];
  });
}

export function writePlanContent(sessionId: string, content: string): void {
  const planPath = getPlanAuthorityPath(sessionId);
  const dir = dirname(planPath);
  const tmpPath = join(dir, `.${sessionId}.${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, planPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function createDefaultPlanContent(input: { sessionId: string; tool: string; worktreePath?: string }): string {
  const worktreeLabel = input.worktreePath ? input.worktreePath : "main";
  return (
    `---\n` +
    `sessionId: ${input.sessionId}\n` +
    `tool: ${input.tool}\n` +
    `worktree: ${worktreeLabel}\n` +
    `updatedAt: ${new Date().toISOString()}\n` +
    `---\n\n` +
    `# Goal\n\n` +
    `TBD\n\n` +
    `# Current Status\n\n` +
    `TBD\n\n` +
    `# Steps\n\n` +
    `- [ ] TBD\n\n` +
    `# Notes\n\n` +
    `- None yet.\n`
  );
}

export function ensureDefaultPlan(input: { sessionId: string; tool: string; worktreePath?: string }): void {
  const planPath = getPlanAuthorityPath(input.sessionId);
  if (existsSync(planPath)) return;
  writePlanContent(input.sessionId, createDefaultPlanContent(input));
}

export function readNonStubPlanBody(sessionId: string): string | undefined {
  const raw = readPlanContent(sessionId)?.replace(FRONTMATTER, "").trim();
  if (!raw || isDefaultPlanBody(raw)) return undefined;
  return raw;
}

export function isDefaultPlanBody(content: string): boolean {
  const normalized = content.replace(/\r/g, "").trim();
  return (
    normalized.includes("# Goal\n\nTBD") &&
    normalized.includes("# Current Status\n\nTBD") &&
    normalized.includes("# Steps\n\n- [ ] TBD")
  );
}
