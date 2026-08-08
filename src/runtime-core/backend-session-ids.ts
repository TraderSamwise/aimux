import { createRuntimeTopologyStore } from "./topology-store.js";
import { getRepoRoot, withProjectPaths } from "../paths.js";
import { discoverBackendSessionId } from "../backend-session-discovery.js";
import { listTopologySessionStates, type RuntimeTopologySessionState } from "./topology-sessions.js";

export interface RecordTopologyBackendSessionIdInput {
  projectRoot?: string;
  sessionId: string;
  backendSessionId: string;
}

export interface RecordTopologyBackendSessionIdResult {
  sessionId: string;
  backendSessionId: string;
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

  if (input.projectRoot) {
    return withProjectPaths(input.projectRoot, () =>
      recordTopologyBackendSessionId({ ...input, projectRoot: undefined }),
    );
  }

  const store = createRuntimeTopologyStore();
  const now = new Date().toISOString();
  let result: RecordTopologyBackendSessionIdResult | undefined;
  store.update((topology) => {
    const session = topology.sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      throw new Error(`Agent "${sessionId}" is not managed in runtime topology`);
    }
    if (session.backendSessionId && session.backendSessionId !== backendSessionId) {
      throw new Error(
        `Agent "${sessionId}" already has backend session "${session.backendSessionId}", cannot replace with "${backendSessionId}"`,
      );
    }

    const selectedBackendSessionId = session.backendSessionId ?? backendSessionId;
    session.backendSessionId = selectedBackendSessionId;
    session.updatedAt = now;
    topology.generatedAt = now;
    result = { sessionId, backendSessionId: selectedBackendSessionId };
    return topology;
  });
  return result!;
}

/**
 * Which of the tools' on-disk session stores to search for an agent.
 *
 * Lives here rather than beside the reconciler because both callers need it and
 * the reconciler already depends on this module; the other direction cycles.
 */
export function discoveryToolKeyForSession(
  session: Pick<RuntimeTopologySessionState, "toolConfigKey" | "tool" | "command">,
): string | undefined {
  return (
    normalizeDiscoveryToolKey(session.toolConfigKey) ??
    normalizeDiscoveryToolKey(session.tool) ??
    normalizeDiscoveryToolKey(session.command)
  );
}

export function normalizeDiscoveryToolKey(value: string | undefined): "claude" | "codex" | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const command = trimmed.split(/[\\/]/).pop()?.toLowerCase();
  if (command === "claude" || command === "codex") return command;
  return undefined;
}

export interface ResolveBackendSessionIdInput {
  projectRoot?: string;
  sessionId: string;
}

export type ResolvedBackendSessionId =
  | { ok: true; backendSessionId: string; source: "topology" | "discovered" }
  | { ok: false; reason: string };

/**
 * The tool's own conversation id for an agent, for callers that can only act
 * natively \u2014 forking and moving both address the conversation by that id.
 *
 * Recorded at launch for both tools, so topology answers this for anything
 * started in the last couple of months. The on-disk fallback is for the older
 * rows, and keeps its refusal to guess between several transcripts in one
 * worktree: a wrong id here forks somebody else's conversation.
 */
export function resolveBackendSessionId(input: ResolveBackendSessionIdInput): ResolvedBackendSessionId {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return { ok: false, reason: "sessionId is required" };

  if (input.projectRoot) {
    return withProjectPaths(input.projectRoot, () => resolveBackendSessionId({ ...input, projectRoot: undefined }));
  }

  const session = listTopologySessionStates().find((entry) => entry.id === sessionId);
  if (!session) {
    return { ok: false, reason: `Agent "${sessionId}" is not managed in runtime topology` };
  }
  if (session.backendSessionId) {
    return { ok: true, backendSessionId: session.backendSessionId, source: "topology" };
  }

  // An agent in the main checkout has no worktreePath, and searching undefined
  // finds nothing \u2014 the refusal would then report a search that never ran.
  const toolKey = discoveryToolKeyForSession(session);
  const cwd = session.worktreePath ?? getRepoRoot();
  const discovered = discoverBackendSessionId(toolKey, cwd);
  if (discovered) return { ok: true, backendSessionId: discovered, source: "discovered" };

  return {
    ok: false,
    reason:
      `Agent "${sessionId}" has no recorded ${toolKey ?? "tool"} session id, and ${cwd} holds no ` +
      `single transcript to recover one from. Agents started before aimux recorded backend ids ` +
      `cannot be forked or moved natively.`,
  };
}
