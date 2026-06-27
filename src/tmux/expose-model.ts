import type { AimuxConfig } from "../config.js";
import {
  listSwitchableAgentItems,
  type AgentListScope,
  type FastControlContext,
  type FastControlItem,
} from "../fast-control.js";
import { listAllProjectsExposeItems } from "../meta-dashboard-model.js";
import { isDashboardWindowName, TmuxRuntimeManager } from "./runtime-manager.js";

/**
 * Exposé zoom ladder. `g` walks up it (worktree → project → global), clamped at
 * the top. The launch context picks the starting rung; zoom state is ephemeral.
 */
export type ExposeScope = "worktree" | "project" | "global";

const SCOPE_LADDER: ExposeScope[] = ["worktree", "project", "global"];

/** A tile's agent item; global-scope items also carry their project. */
export type ExposeScopeItem = FastControlItem & { projectRoot?: string; projectName?: string };

export type ExposeSublabel = "none" | "worktree" | "project-worktree";

export interface ExposeScopeView {
  scope: ExposeScope;
  items: ExposeScopeItem[];
  scopeLabel: string;
  sublabel: ExposeSublabel;
}

export interface LoadExposeScopeDeps {
  tmux?: TmuxRuntimeManager;
  listItemsFn?: typeof listSwitchableAgentItems;
  listAllFn?: typeof listAllProjectsExposeItems;
}

/** Next rung up the ladder; the top (global) is a no-op. */
export function nextExposeScope(scope: ExposeScope): ExposeScope {
  const i = SCOPE_LADDER.indexOf(scope);
  return SCOPE_LADDER[Math.min(i + 1, SCOPE_LADDER.length - 1)]!;
}

/** Starting rung for a freshly opened Exposé, derived from the launch context. */
export function initialExposeScope(
  crossProject: boolean,
  context: FastControlContext,
  config: AimuxConfig,
): ExposeScope {
  if (crossProject) return "global";
  if (config.expose.initialScope !== "worktree") return config.expose.initialScope;
  const currentWindow = context.currentWindow?.trim();
  if (!context.currentWindowId?.trim()) return "project";
  if (currentWindow && isDashboardWindowName(currentWindow)) return "project";
  return "worktree";
}

/** Resolve the tiles, label, and sublabel kind for a given rung. */
export function loadExposeScopeItems(
  scope: ExposeScope,
  context: FastControlContext,
  deps: LoadExposeScopeDeps = {},
): ExposeScopeView {
  const tmux = deps.tmux ?? new TmuxRuntimeManager();
  const listItems = deps.listItemsFn ?? listSwitchableAgentItems;
  const listAll = deps.listAllFn ?? listAllProjectsExposeItems;

  if (scope === "global") {
    return { scope, items: listAll({ tmux }), scopeLabel: "all projects", sublabel: "project-worktree" };
  }
  const agentScope: AgentListScope = scope === "project" ? "all" : "worktree";
  return {
    scope,
    items: listItems(context, tmux, { scope: agentScope }),
    scopeLabel: scope === "project" ? "all worktrees" : "this worktree",
    sublabel: scope === "project" ? "worktree" : "none",
  };
}
