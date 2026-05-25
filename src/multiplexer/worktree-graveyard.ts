import { existsSync, readFileSync } from "node:fs";

import { getWorktreeGraveyardPath } from "../paths.js";
import type { ServiceState, SessionState } from "./index.js";

export interface WorktreeGraveyardEntry {
  name: string;
  path: string;
  branch: string;
  createdAt?: string;
  graveyardedAt: string;
  agents: SessionState[];
  services?: ServiceState[];
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

export function listWorktreeGraveyardPaths(): Set<string> {
  return new Set(listWorktreeGraveyardEntries().map((entry) => entry.path));
}
