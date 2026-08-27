import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIBRARY_DOC_ALLOWLIST = [
  { path: "AGENTS.md", kind: "instructions", title: "AGENTS.md" },
  { path: "CLAUDE.md", kind: "adapter", title: "CLAUDE.md" },
  { path: "CODEX.md", kind: "adapter", title: "CODEX.md" },
  { path: "README.md", kind: "project", title: "README.md" },
] as const;

function isLibraryPathExposed(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return !normalized.startsWith(".aimux/") && !normalized.endsWith("config.json");
}

export function listLibraryDocuments(projectRoot = process.cwd()) {
  return LIBRARY_DOC_ALLOWLIST.flatMap((entry) => {
    if (!isLibraryPathExposed(entry.path)) return [];
    try {
      const fullPath = join(projectRoot, entry.path);
      if (!existsSync(fullPath)) return [];
      const stat = statSync(fullPath);
      if (!stat.isFile()) return [];
      const content = readFileSync(fullPath, "utf8");
      return [
        {
          id: entry.path,
          title: entry.title,
          path: entry.path,
          kind: entry.kind,
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
          content: content.slice(0, 40_000),
          truncated: content.length > 40_000,
        },
      ];
    } catch {
      return [];
    }
  });
}
