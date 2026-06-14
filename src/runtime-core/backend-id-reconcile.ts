import { discoverBackendSessionId } from "../backend-session-discovery.js";
import { getRepoRoot } from "../paths.js";
import { recordTopologyBackendSessionId } from "./backend-session-ids.js";
import { listTopologySessionStates, type RuntimeTopologySessionState } from "./topology-sessions.js";

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
    const backendSessionId = reconcileBackendSessionIdForSession(session, projectRoot);
    if (backendSessionId) reconciled.push({ id: session.id, backendSessionId });
  }
  return { reconciled };
}

export function reconcileBackendSessionIdForSession(
  session: RuntimeTopologySessionState,
  projectRoot = getRepoRoot(),
): string | null {
  if (session.backendSessionId) return null;
  const cwd = session.worktreePath ?? projectRoot;
  const discovered = discoverBackendSessionId(session.toolConfigKey, cwd);
  if (!discovered) return null;
  return recordTopologyBackendSessionId({
    projectRoot,
    sessionId: session.id,
    backendSessionId: discovered,
  }).backendSessionId;
}
