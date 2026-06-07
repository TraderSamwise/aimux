import { discoverBackendSessionId } from "../backend-session-discovery.js";
import { getRepoRoot } from "../paths.js";
import { listTopologySessionStates, upsertTopologySession } from "./topology-sessions.js";

export interface BackendIdReconcileResult {
  reconciled: Array<{ id: string; backendSessionId: string }>;
}

/**
 * Backfill missing backend session ids for offline sessions from each tool's
 * on-disk session store, so a crash that lost the id before capture does not
 * leave the agent unresumable. Idempotent: sessions that already have an id,
 * or whose id cannot be found on disk, are left untouched.
 */
export function reconcileOfflineBackendSessionIds(projectRoot = getRepoRoot()): BackendIdReconcileResult {
  const reconciled: Array<{ id: string; backendSessionId: string }> = [];
  for (const session of listTopologySessionStates({ statuses: ["offline"] })) {
    if (session.backendSessionId) continue;
    const cwd = session.worktreePath ?? projectRoot;
    const discovered = discoverBackendSessionId(session.toolConfigKey, cwd);
    if (!discovered) continue;
    upsertTopologySession({ ...session, backendSessionId: discovered }, "offline", { projectRoot });
    reconciled.push({ id: session.id, backendSessionId: discovered });
  }
  return { reconciled };
}
