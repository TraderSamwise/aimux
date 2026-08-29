import type { ResolvedAgentIdentity } from "../runtime-core/backend-session-ids.js";

export interface CliAgentIdentityPayload {
  ok: true;
  projectRoot: string;
  canonical: string;
  aimuxId: string;
  backendSessionId: string;
  source: "topology" | "discovered";
  status?: string;
  worktreePath?: string;
}

export interface CliAgentIdentityErrorPayload {
  ok: false;
  projectRoot: string;
  sessionId: string;
  error: string;
}

export function buildAgentIdentityPayload(
  projectRoot: string,
  identity: Extract<ResolvedAgentIdentity, { ok: true }>,
): CliAgentIdentityPayload {
  return {
    ok: true,
    projectRoot,
    canonical: identity.toolConfigKey ?? identity.tool ?? identity.command ?? "?",
    aimuxId: identity.sessionId,
    backendSessionId: identity.backendSessionId,
    source: identity.source,
    status: identity.status,
    worktreePath: identity.worktreePath,
  };
}

export function buildAgentIdentityErrorPayload(
  projectRoot: string,
  identity: Extract<ResolvedAgentIdentity, { ok: false }>,
): CliAgentIdentityErrorPayload {
  return { ok: false, projectRoot, sessionId: identity.sessionId, error: identity.reason };
}

export function renderAgentIdentityLines(payload: CliAgentIdentityPayload): string[] {
  const lines = [
    `${payload.aimuxId}  canonical=${payload.canonical}  backend=${payload.backendSessionId}  ` +
      `status=${payload.status ?? "?"}  source=${payload.source}`,
  ];
  if (payload.worktreePath) lines.push(`worktree: ${payload.worktreePath}`);
  return lines;
}
