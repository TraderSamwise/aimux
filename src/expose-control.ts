import { resolve as pathResolve } from "node:path";
import { listSwitchableAgentItems, type FastControlItem } from "./fast-control.js";
import { listProjects } from "./paths.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";

export interface GlobalExposeItem extends FastControlItem {
  projectId: string;
  projectName: string;
  projectRoot: string;
}

export interface ExposeControlDeps {
  tmux?: TmuxRuntimeManager;
  listProjectsFn?: typeof listProjects;
  listItemsFn?: typeof listSwitchableAgentItems;
}

function sessionsByProjectRoot(tmux: TmuxRuntimeManager, sessionNames: string[]): Map<string, string[]> {
  const sessions = new Map<string, string[]>();
  for (const sessionName of sessionNames) {
    try {
      const root = tmux.getSessionOption(sessionName, "@aimux-project-root");
      if (!root) continue;
      const resolvedRoot = pathResolve(root);
      sessions.set(resolvedRoot, [...(sessions.get(resolvedRoot) ?? []), sessionName]);
    } catch {
      continue;
    }
  }
  return sessions;
}

export function listAllProjectsExposeItems(deps: ExposeControlDeps = {}): GlobalExposeItem[] {
  const tmux = deps.tmux ?? new TmuxRuntimeManager();
  const listProjectsFn = deps.listProjectsFn ?? listProjects;
  const listItemsFn = deps.listItemsFn ?? listSwitchableAgentItems;
  const sessions = sessionsByProjectRoot(tmux, tmux.listSessionNames());
  const projects = [...listProjectsFn()].sort((a, b) => a.name.localeCompare(b.name));
  const items: GlobalExposeItem[] = [];

  for (const project of projects) {
    const projectSessions = sessions.get(pathResolve(project.repoRoot)) ?? [];
    if (projectSessions.length === 0) continue;
    try {
      for (const item of listItemsFn({ projectRoot: project.repoRoot, sessionNames: projectSessions }, tmux, {
        scope: "all",
      })) {
        items.push({ ...item, projectId: project.id, projectName: project.name, projectRoot: project.repoRoot });
      }
    } catch {
      continue;
    }
  }

  return items;
}
