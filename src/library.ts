import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LibraryEntry } from "./project-api-contract.js";

export type { LibraryEntry, LibraryEntryKind } from "./project-api-contract.js";

// Mirrors metadata-server's LIBRARY_DOC_ALLOWLIST so the TUI library and the
// app/HTTP library surface the same project documents.
const DOC_ALLOWLIST: ReadonlyArray<string> = ["AGENTS.md", "CLAUDE.md", "CODEX.md", "README.md"];
const DEFAULT_PREVIEW_BYTES = 4000;

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER, "").trim();
}

/** True when a plan file is still the untouched auto-generated stub. */
export function isStubPlan(content: string): boolean {
  const normalized = stripFrontmatter(content.replace(/\r/g, ""));
  return (
    normalized.includes("# Goal\n\nTBD") &&
    normalized.includes("# Current Status\n\nTBD") &&
    normalized.includes("# Steps\n\n- [ ] TBD")
  );
}

function frontmatterUpdatedAt(content: string): string | undefined {
  const match = content.match(FRONTMATTER);
  if (!match) return undefined;
  for (const line of match[0].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0 && line.slice(0, idx).trim() === "updatedAt") {
      const value = line.slice(idx + 1).trim();
      // Ignore malformed timestamps so they don't degrade the recency sort.
      return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
    }
  }
  return undefined;
}

export interface LibraryLoadOptions {
  repoRoot: string;
  plansDir: string;
  resolveLabel?: (sessionId: string) => string | undefined;
  previewBytes?: number;
}

export function loadLibraryEntries(opts: LibraryLoadOptions): LibraryEntry[] {
  const previewBytes = opts.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const entries: LibraryEntry[] = [];

  for (const file of DOC_ALLOWLIST) {
    const path = join(opts.repoRoot, file);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf-8");
      entries.push({
        id: `doc:${file}`,
        kind: "doc",
        title: file,
        path,
        updatedAt: statSync(path).mtime.toISOString(),
        preview: content.slice(0, previewBytes),
      });
    } catch {}
  }

  let planFiles: string[] = [];
  try {
    planFiles = readdirSync(opts.plansDir).filter((file) => file.endsWith(".md"));
  } catch {}
  for (const file of planFiles) {
    const path = join(opts.plansDir, file);
    try {
      const content = readFileSync(path, "utf-8");
      if (isStubPlan(content)) continue;
      const sessionId = file.replace(/\.md$/, "");
      const label = opts.resolveLabel?.(sessionId);
      entries.push({
        id: `plan:${sessionId}`,
        kind: "plan",
        title: label ?? sessionId,
        path,
        sessionId,
        label,
        updatedAt: frontmatterUpdatedAt(content) ?? statSync(path).mtime.toISOString(),
        preview: stripFrontmatter(content).slice(0, previewBytes),
      });
    } catch {}
  }

  return entries.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}
