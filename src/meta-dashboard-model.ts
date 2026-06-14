import { basename, resolve as pathResolve } from "node:path";
import { listProjects } from "./paths.js";
import { listWorktrees } from "./worktree.js";
import { listSwitchableAgentItems, type FastControlContext, type FastControlItem } from "./fast-control.js";
import { TmuxRuntimeManager, type TmuxTarget } from "./tmux/runtime-manager.js";

export interface MetaRow {
  kind: "agent" | "service";
  sessionId: string;
  label: string;
  tool: string;
  activity?: string;
  attention?: string;
  urgency: number;
  target: TmuxTarget;
}

export interface MetaWorktreeGroup {
  /** null for the main checkout. */
  worktreePath: string | null;
  name: string;
  branch: string;
  isMainCheckout: boolean;
  rows: MetaRow[];
}

export interface MetaProject {
  id: string;
  name: string;
  repoRoot: string;
  /** Whether a live tmux session exists; only running projects are enterable. */
  running: boolean;
  worktreeGroups: MetaWorktreeGroup[];
}

export interface MetaDashboardModel {
  projects: MetaProject[];
}

export interface MetaDashboardDeps {
  tmux?: TmuxRuntimeManager;
  listProjectsFn?: typeof listProjects;
  listItemsFn?: typeof listSwitchableAgentItems;
  listWorktreesFn?: typeof listWorktrees;
}

const MAIN_KEY = "__main__";

function isProjectRunning(tmux: TmuxRuntimeManager, repoRoot: string, sessionNames: string[]): boolean {
  const host = tmux.getProjectSession(repoRoot).sessionName;
  return sessionNames.some((name) => name === host || name.startsWith(`${host}-client-`));
}

function worktreeKey(repoRoot: string, worktreePath?: string): string {
  if (!worktreePath || pathResolve(worktreePath) === pathResolve(repoRoot)) return MAIN_KEY;
  return pathResolve(worktreePath);
}

function groupItemsByWorktree(
  repoRoot: string,
  items: FastControlItem[],
  worktrees: ReturnType<typeof listWorktrees>,
): MetaWorktreeGroup[] {
  const branchByPath = new Map(worktrees.map((wt) => [pathResolve(wt.path), wt.branch] as const));
  const groups = new Map<string, MetaWorktreeGroup>();

  for (const item of items) {
    const key = worktreeKey(repoRoot, item.metadata.worktreePath);
    const isMain = key === MAIN_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        worktreePath: isMain ? null : key,
        name: isMain ? "main" : basename(key),
        branch: isMain ? (branchByPath.get(pathResolve(repoRoot)) ?? "") : (branchByPath.get(key) ?? ""),
        isMainCheckout: isMain,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push({
      kind: item.metadata.kind === "service" ? "service" : "agent",
      sessionId: item.metadata.sessionId,
      label: item.label,
      tool: item.metadata.command || item.target.windowName,
      activity: item.metadata.activity,
      attention: item.metadata.attention,
      urgency: item.urgency,
      target: item.target,
    });
  }

  // Main checkout first, then other worktrees in first-seen order.
  return [...groups.values()].sort((a, b) => Number(b.isMainCheckout) - Number(a.isMainCheckout));
}

/**
 * Build the cross-project meta dashboard model for the current aimux instance
 * (AIMUX_HOME-scoped via listProjects). Running projects are grouped by worktree
 * with empty worktrees omitted; stopped projects are listed with no groups.
 */
export function buildMetaDashboardModel(deps: MetaDashboardDeps = {}): MetaDashboardModel {
  const tmux = deps.tmux ?? new TmuxRuntimeManager();
  const listProjectsFn = deps.listProjectsFn ?? listProjects;
  const listItemsFn = deps.listItemsFn ?? listSwitchableAgentItems;
  const listWorktreesFn = deps.listWorktreesFn ?? listWorktrees;

  const sessionNames = tmux.listSessionNames();
  const projects = [...listProjectsFn()].sort((a, b) => a.name.localeCompare(b.name));

  const metaProjects: MetaProject[] = projects.map((project) => {
    const running = isProjectRunning(tmux, project.repoRoot, sessionNames);
    if (!running) {
      return { id: project.id, name: project.name, repoRoot: project.repoRoot, running: false, worktreeGroups: [] };
    }
    const context: FastControlContext = { projectRoot: project.repoRoot };
    const items = listItemsFn(context, tmux, { scope: "all" });
    const worktreeGroups = groupItemsByWorktree(project.repoRoot, items, listWorktreesFn(project.repoRoot));
    return { id: project.id, name: project.name, repoRoot: project.repoRoot, running: true, worktreeGroups };
  });

  return { projects: metaProjects };
}

export interface MetaExposeItem extends FastControlItem {
  projectId: string;
  projectName: string;
  projectRoot: string;
}

/** Flat list of agent/service windows across every running project, for cross-project Exposé. */
export function listAllProjectsExposeItems(deps: MetaDashboardDeps = {}): MetaExposeItem[] {
  const tmux = deps.tmux ?? new TmuxRuntimeManager();
  const listProjectsFn = deps.listProjectsFn ?? listProjects;
  const listItemsFn = deps.listItemsFn ?? listSwitchableAgentItems;

  const sessionNames = tmux.listSessionNames();
  const projects = [...listProjectsFn()].sort((a, b) => a.name.localeCompare(b.name));

  const result: MetaExposeItem[] = [];
  for (const project of projects) {
    if (!isProjectRunning(tmux, project.repoRoot, sessionNames)) continue;
    const items = listItemsFn({ projectRoot: project.repoRoot }, tmux, { scope: "all" });
    for (const item of items) {
      result.push({ ...item, projectId: project.id, projectName: project.name, projectRoot: project.repoRoot });
    }
  }
  return result;
}
