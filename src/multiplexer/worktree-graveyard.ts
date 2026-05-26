import { basename } from "node:path";
import type { ServiceState, SessionState } from "./index.js";
import { listTopologySessionStates } from "../runtime-core/topology-sessions.js";
import { listTopologyServiceStates } from "../runtime-core/topology-services.js";
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
  const sessions = listTopologySessionStates();
  const services = listTopologyServiceStates();
  return listTopologyWorktreeGraveyard().map((entry) => ({
    name: entry.name ?? (basename(entry.path) || entry.path),
    path: entry.path,
    branch: entry.branch ?? "",
    graveyardedAt: entry.graveyardedAt,
    agents: sessions.filter((session) => session.worktreePath === entry.path) as SessionState[],
    services: services.filter((service) => service.worktreePath === entry.path) as ServiceState[],
  }));
}

export function listWorktreeGraveyardPaths(): Set<string> {
  return listTopologyWorktreeGraveyardPaths();
}
