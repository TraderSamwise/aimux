import { existsSync, readFileSync } from "node:fs";

import { getWorktreeGraveyardPath } from "../paths.js";
import type { ServiceState, SessionState } from "./index.js";
import {
  listTopologyWorktreeGraveyard,
  listTopologyWorktreeGraveyardPaths,
} from "../runtime-core/topology-worktrees.js";

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
  const topologyEntries = listTopologyWorktreeGraveyard().map((entry) => ({
    name: entry.name ?? entry.path.split("/").pop() ?? entry.path,
    path: entry.path,
    branch: entry.branch ?? "",
    graveyardedAt: entry.graveyardedAt,
    agents: [],
    services: [],
  }));
  const path = getWorktreeGraveyardPath();
  if (!existsSync(path)) return topologyEntries;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const legacyEntries = Array.isArray(parsed) ? (parsed as WorktreeGraveyardEntry[]) : [];
    const seen = new Set(topologyEntries.map((entry) => entry.path));
    return [...topologyEntries, ...legacyEntries.filter((entry) => !seen.has(entry.path))];
  } catch {
    return topologyEntries;
  }
}

export function listWorktreeGraveyardPaths(): Set<string> {
  return new Set([
    ...listTopologyWorktreeGraveyardPaths(),
    ...listWorktreeGraveyardEntries().map((entry) => entry.path),
  ]);
}
