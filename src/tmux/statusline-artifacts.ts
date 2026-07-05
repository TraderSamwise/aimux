import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeTextAtomic } from "../atomic-write.js";
import { debug } from "../debug.js";
import { getProjectStateDirFor } from "../paths.js";
import { loadStatusline, renderTmuxStatuslineFromData } from "./statusline.js";
import type { TmuxRuntimeManager } from "./runtime-manager.js";

export function rewriteDashboardStatuslineArtifacts(
  projectRoot: string,
  tmux: TmuxRuntimeManager,
  dashboardSessionName?: string,
): void {
  const data = loadStatusline(projectRoot);
  if (!data) return;
  const statusDir = join(getProjectStateDirFor(projectRoot), "tmux-statusline");
  mkdirSync(statusDir, { recursive: true });

  const writeStatusFile = (name: string, content: string): void => {
    try {
      writeTextAtomic(join(statusDir, name), `${content}\n`);
    } catch (error) {
      debug(
        `statusline write failed for ${name}: ${error instanceof Error ? error.message : String(error)}`,
        "statusline",
      );
    }
  };

  const dashboardTop = renderTmuxStatuslineFromData(data, projectRoot, "top", {
    currentWindow: "dashboard",
    currentPath: projectRoot,
  });
  const dashboardBottom = renderTmuxStatuslineFromData(data, projectRoot, "bottom", {
    currentWindow: "dashboard",
    currentPath: projectRoot,
    currentSession: dashboardSessionName,
  });
  writeStatusFile("top-dashboard.txt", dashboardTop);
  writeStatusFile("bottom-dashboard.txt", dashboardBottom);
  if (dashboardSessionName) {
    writeStatusFile(`bottom-dashboard-${dashboardSessionName}.txt`, dashboardBottom);
  }

  for (const entry of [...(data.sessions ?? []), ...(data.teammates ?? [])]) {
    if (!entry.tmuxWindowId) continue;
    const renderOptions = {
      currentWindow: entry.windowName,
      currentWindowId: entry.tmuxWindowId,
      currentPath: entry.worktreePath ?? projectRoot,
    };
    writeStatusFile(
      `top-${entry.tmuxWindowId}.txt`,
      renderTmuxStatuslineFromData(data, projectRoot, "top", renderOptions),
    );
    writeStatusFile(
      `bottom-${entry.tmuxWindowId}.txt`,
      renderTmuxStatuslineFromData(data, projectRoot, "bottom", renderOptions),
    );
  }

  tmux.refreshStatus();
}
