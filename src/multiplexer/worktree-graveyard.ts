import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { getWorktreeGraveyardPath } from "../paths.js";
import type { SessionState } from "./index.js";

export interface WorktreeGraveyardEntry {
  name: string;
  path: string;
  branch: string;
  createdAt?: string;
  graveyardedAt: string;
  agents: SessionState[];
}

export function listWorktreeGraveyardEntries(): WorktreeGraveyardEntry[] {
  const path = getWorktreeGraveyardPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? (parsed as WorktreeGraveyardEntry[]) : [];
  } catch {
    return [];
  }
}

export function writeWorktreeGraveyardEntries(entries: WorktreeGraveyardEntry[]): void {
  writeFileSync(getWorktreeGraveyardPath(), JSON.stringify(entries, null, 2) + "\n");
}

export function listWorktreeGraveyardPaths(): Set<string> {
  return new Set(listWorktreeGraveyardEntries().map((entry) => entry.path));
}
