import type { ToolConfig } from "./config.js";

export type SessionRestoreState = "ready" | "blocked";

export interface SessionRestorability {
  restoreState: SessionRestoreState;
  restoreBlockedReason?: string;
}

export interface RestorableSessionLike {
  id?: string;
  command?: string;
  tool?: string;
  toolConfigKey?: string;
  status?: string;
  backendSessionId?: string;
  freshRelaunchAllowed?: boolean;
  restoreState?: SessionRestoreState;
  restoreBlockedReason?: string;
}

type RestoreToolConfig = Pick<ToolConfig, "resumeArgs" | "resumeByBackendSessionId">;

export const DEFAULT_EXACT_BACKEND_RESUME_TOOLS: Record<string, RestoreToolConfig> = {
  claude: { resumeArgs: ["--resume", "{sessionId}"], resumeByBackendSessionId: true },
  codex: { resumeArgs: ["resume", "{sessionId}"], resumeByBackendSessionId: true },
};

export function exactBackendResumeSupported(toolCfg: RestoreToolConfig | undefined): boolean {
  return Boolean(
    toolCfg?.resumeArgs?.some((arg) => arg.includes("{sessionId}")) && toolCfg.resumeByBackendSessionId !== false,
  );
}

export function describeSessionRestorability(
  session: RestorableSessionLike,
  tools: Record<string, RestoreToolConfig>,
): SessionRestorability | undefined {
  if (session.restoreState === "blocked") {
    return {
      restoreState: "blocked",
      restoreBlockedReason: session.restoreBlockedReason ?? "not restorable",
    };
  }
  if (session.restoreBlockedReason) {
    return {
      restoreState: "blocked",
      restoreBlockedReason: session.restoreBlockedReason,
    };
  }
  if (session.status && session.status !== "offline") return undefined;
  const toolKey = session.toolConfigKey ?? session.tool ?? session.command;
  const toolCfg = toolKey ? tools[toolKey] : undefined;
  if (!toolKey || !toolCfg) {
    return { restoreState: "blocked", restoreBlockedReason: "unknown agent tool" };
  }
  if (!exactBackendResumeSupported(toolCfg)) {
    return {
      restoreState: "blocked",
      restoreBlockedReason: `agent tool "${toolKey}" does not support exact backend resume`,
    };
  }
  if (!session.backendSessionId && !session.freshRelaunchAllowed) {
    return {
      restoreState: "blocked",
      restoreBlockedReason: "missing exact resumable backend session id",
    };
  }
  return { restoreState: "ready" };
}

export function assertSessionRestorable(
  session: RestorableSessionLike,
  tools: Record<string, RestoreToolConfig>,
): void {
  const restorability = describeSessionRestorability(session, tools);
  if (restorability?.restoreState === "blocked") {
    throw new Error(`Cannot restore session "${session.id ?? "unknown"}": ${restorability.restoreBlockedReason}`);
  }
}
