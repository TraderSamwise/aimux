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
  return listTopologyWorktreeGraveyard().map((entry) => ({
    name: entry.name ?? entry.path.split("/").pop() ?? entry.path,
    path: entry.path,
    branch: entry.branch ?? "",
    graveyardedAt: entry.graveyardedAt,
    agents: [],
    services: [],
  }));
}

export function listWorktreeGraveyardPaths(): Set<string> {
  return listTopologyWorktreeGraveyardPaths();
}
