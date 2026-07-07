import { readHistory } from "./context/history.js";
import { loadMetadataState } from "./metadata-store.js";
import { getRepoRoot, withProjectPaths } from "./paths.js";

export interface FreshRelaunchSessionLike {
  id?: string;
  backendSessionId?: string;
  freshRelaunchAllowed?: boolean;
}

function hasSessionHistory(sessionId: string, projectRoot: string): boolean {
  return withProjectPaths(projectRoot, () => readHistory(sessionId, { lastN: 1 }).length > 0);
}

export function shouldRelaunchFreshSession(session: FreshRelaunchSessionLike, projectRoot = getRepoRoot()): boolean {
  const sessionId = session.id?.trim();
  if (!sessionId) return false;

  const derived = loadMetadataState(projectRoot).sessions[sessionId]?.derived;
  if (derived?.activity === "error" || derived?.attention === "error") return true;

  if (session.backendSessionId) return false;
  return session.freshRelaunchAllowed === true;
}

export function shouldMarkFreshRelaunchAllowed(
  session: FreshRelaunchSessionLike,
  projectRoot = getRepoRoot(),
): boolean {
  const sessionId = session.id?.trim();
  if (!sessionId || session.backendSessionId) return false;
  return !hasSessionHistory(sessionId, projectRoot);
}
