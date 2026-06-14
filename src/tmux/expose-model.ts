import type { AimuxConfig } from "../config.js";
import {
  listSwitchableAgentItems,
  type AgentListScope,
  type FastControlContext,
  type FastControlItem,
} from "../fast-control.js";
import { isDashboardWindowName, TmuxRuntimeManager } from "./runtime-manager.js";

/**
 * Exposé scope: "all" shows agents across every worktree, "worktree" shows only
 * the agents in the currently focused agent's worktree. Forced-global config wins;
 * otherwise the dashboard window (or an unidentified window) implies "all".
 */
export function resolveExposeScope(context: FastControlContext, config: AimuxConfig): AgentListScope {
  if (config.expose.forceGlobalScope) return "all";
  const currentWindow = context.currentWindow?.trim();
  if (!context.currentWindowId?.trim()) return "all";
  if (currentWindow && isDashboardWindowName(currentWindow)) return "all";
  return "worktree";
}

export interface ExposeAgentList {
  scope: AgentListScope;
  items: FastControlItem[];
}

export function listExposeAgentItems(
  context: FastControlContext,
  config: AimuxConfig,
  tmux = new TmuxRuntimeManager(),
): ExposeAgentList {
  const scope = resolveExposeScope(context, config);
  return { scope, items: listSwitchableAgentItems(context, tmux, { scope }) };
}
