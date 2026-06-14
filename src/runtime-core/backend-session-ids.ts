import { getRepoRoot } from "../paths.js";
import {
  listTopologySessionStates,
  upsertTopologySession,
  type RuntimeTopologySessionState,
} from "./topology-sessions.js";
import type { RuntimeTopologySessionStatus } from "./topology-store.js";

export interface RecordTopologyBackendSessionIdInput {
  projectRoot?: string;
  sessionId: string;
  backendSessionId: string;
}

export interface RecordTopologyBackendSessionIdResult {
  sessionId: string;
  backendSessionId: string;
}

function statusForSession(session: RuntimeTopologySessionState): RuntimeTopologySessionStatus {
  return session.status ?? (session.lifecycle === "offline" ? "offline" : "running");
}

/**
 * Strictly latch the exact tool backend session id into topology.
 *
 * This is intentionally not best-effort: callers may decide whether a recording
 * failure is fatal to their own workflow, but the mutation itself must not claim
 * success when the topology row is missing or already points at a different
 * backend session.
 */
export function recordTopologyBackendSessionId(
  input: RecordTopologyBackendSessionIdInput,
): RecordTopologyBackendSessionIdResult {
  const sessionId = input.sessionId.trim();
  const backendSessionId = input.backendSessionId.trim();
  if (!sessionId) throw new Error("sessionId is required");
  if (!backendSessionId) throw new Error("backendSessionId is required");

  const session = listTopologySessionStates().find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error(`Agent "${sessionId}" is not managed in runtime topology`);
  }
  if (session.backendSessionId && session.backendSessionId !== backendSessionId) {
    throw new Error(
      `Agent "${sessionId}" already has backend session "${session.backendSessionId}", cannot replace with "${backendSessionId}"`,
    );
  }

  const selectedBackendSessionId = session.backendSessionId ?? backendSessionId;
  upsertTopologySession(
    { ...session, backendSessionId: selectedBackendSessionId },
    statusForSession(session),
    { projectRoot: input.projectRoot ?? getRepoRoot() },
  );
  return { sessionId, backendSessionId: selectedBackendSessionId };
}
