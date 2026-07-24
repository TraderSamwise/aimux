import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { resolve as pathResolve } from "node:path";
import { log } from "./debug.js";
import { EXPOSE_PREVIEW_CAPTURE_LINES } from "./expose-preview-cache.js";
import { type FastControlItem, listSwitchableAgentItems } from "./fast-control.js";
import { getProjectStateDirById, getProjectStateDirFor, withProjectPaths } from "./paths.js";
import type { ExposePreviewSnapshot } from "./project-api-contract.js";
import {
  type HotExposeScopeWrite,
  readHotExposeScopeView,
  writeHotExposeScopeViews,
} from "./tmux/expose-hot-snapshot.js";
import type { ExposeScopeItem, ExposeScopeView } from "./tmux/expose-model.js";
import { isDashboardWindowName, TmuxRuntimeManager } from "./tmux/runtime-manager.js";

const EXPOSE_HOT_SNAPSHOT_MAX_LAUNCH_CONTEXTS = 6;

export interface ExposeHotSnapshotWorkerProject {
  id: string;
  name: string;
  path: string;
  serviceAlive?: boolean;
}

export type ExposeHotSnapshotWorkerData =
  | { kind: "project"; projectRoot: string }
  | { kind: "global"; projects: ExposeHotSnapshotWorkerProject[] };

function capturePreview(
  item: FastControlItem,
  tmux: TmuxRuntimeManager,
  capturedAt: string,
  cache: Map<string, ExposePreviewSnapshot | undefined>,
): ExposePreviewSnapshot | undefined {
  if (cache.has(item.target.windowId)) return cache.get(item.target.windowId);
  let snapshot: ExposePreviewSnapshot | undefined;
  try {
    snapshot = {
      output: tmux.captureTarget(item.target, {
        startLine: -EXPOSE_PREVIEW_CAPTURE_LINES,
        includeEscapes: true,
      }),
      capturedAt,
      source: "capture",
      windowId: item.target.windowId,
      startLine: -EXPOSE_PREVIEW_CAPTURE_LINES,
      lineCount: EXPOSE_PREVIEW_CAPTURE_LINES,
    };
  } catch {
    snapshot = undefined;
  }
  cache.set(item.target.windowId, snapshot);
  return snapshot;
}

function attachCapturedPreviews(
  rawItems: FastControlItem[],
  tmux: TmuxRuntimeManager,
  capturedAt: string,
  cache: Map<string, ExposePreviewSnapshot | undefined>,
): FastControlItem[] {
  return rawItems.map((item) => {
    const previewSnapshot = capturePreview(item, tmux, capturedAt, cache);
    return previewSnapshot ? { ...item, previewSnapshot } : item;
  });
}

export function refreshProjectExposeHotSnapshots(projectRoot: string): void {
  withProjectPaths(projectRoot, () => {
    const resolvedProjectRoot = pathResolve(projectRoot);
    const projectStateDir = getProjectStateDirFor(resolvedProjectRoot);
    const tmux = new TmuxRuntimeManager();
    const capturedAt = new Date().toISOString();
    const captureCache = new Map<string, ExposePreviewSnapshot | undefined>();
    const projectRawItems = listSwitchableAgentItems(
      { projectRoot: resolvedProjectRoot, currentPath: resolvedProjectRoot },
      tmux,
      {
        scope: "all",
      },
    );
    const projectItems = attachCapturedPreviews(projectRawItems, tmux, capturedAt, captureCache);
    const snapshotWrites: HotExposeScopeWrite[] = [
      {
        key: { projectRoot: resolvedProjectRoot, scope: "project" },
        view: { scope: "project", scopeLabel: "all worktrees", sublabel: "worktree", items: projectItems },
      },
    ];

    const liveLaunchContexts = tmux
      .listProjectManagedWindows(resolvedProjectRoot)
      .filter(({ target }) => !target.paneDead && !isDashboardWindowName(target.windowName));
    const keepLaunchWindowIds = new Set(liveLaunchContexts.map(({ target }) => target.windowId));
    const refreshLaunchContexts = liveLaunchContexts.slice(0, EXPOSE_HOT_SNAPSHOT_MAX_LAUNCH_CONTEXTS);
    for (const { target, metadata } of refreshLaunchContexts) {
      const worktreePath = pathResolve(metadata.worktreePath || resolvedProjectRoot);
      const worktreeRawItems = listSwitchableAgentItems(
        {
          projectRoot: resolvedProjectRoot,
          currentPath: worktreePath,
          currentWindow: target.windowName,
          currentWindowId: target.windowId,
        },
        tmux,
        { scope: "worktree" },
      );
      const worktreeItems = attachCapturedPreviews(worktreeRawItems, tmux, capturedAt, captureCache);
      snapshotWrites.push({
        key: {
          projectRoot: resolvedProjectRoot,
          scope: "worktree",
          worktreeKey: worktreePath,
          launchWindowId: target.windowId,
        },
        view: { scope: "worktree", scopeLabel: "this worktree", sublabel: "none", items: worktreeItems },
      });
    }
    writeHotExposeScopeViews(projectStateDir, snapshotWrites, {
      prune: { projectRoot: resolvedProjectRoot, scopes: ["worktree"], keepLaunchWindowIds },
    });
  });
}

export function buildGlobalExposeHotSnapshotView(projects: ExposeHotSnapshotWorkerProject[]): ExposeScopeView {
  const items: ExposeScopeItem[] = [];
  for (const project of projects) {
    try {
      const projectRoot = pathResolve(project.path);
      const projectView = readHotExposeScopeView(getProjectStateDirById(project.id), {
        projectRoot,
        scope: "project",
      });
      if (!projectView) continue;
      for (const item of projectView.items) {
        items.push({ ...item, projectId: project.id, projectRoot, projectName: project.name });
      }
    } catch {
      continue;
    }
  }
  return {
    scope: "global",
    scopeLabel: "all projects",
    sublabel: "project-worktree",
    items,
  };
}

export function refreshGlobalExposeHotSnapshots(projects: ExposeHotSnapshotWorkerProject[]): void {
  const activeProjects = projects.filter((project) => project.serviceAlive);
  const view = buildGlobalExposeHotSnapshotView(activeProjects);
  for (const project of activeProjects) {
    try {
      const projectRoot = pathResolve(project.path);
      writeHotExposeScopeViews(getProjectStateDirById(project.id), [
        {
          key: { projectRoot, scope: "global" },
          view,
        },
      ]);
    } catch {
      continue;
    }
  }
}

export function startExposeHotSnapshotWorker(
  data: ExposeHotSnapshotWorkerData,
  options: { category: string; description: string; timeoutMs?: number },
): Worker {
  const worker = new Worker(new URL("./expose-hot-snapshot-worker.js", import.meta.url), {
    workerData: data,
  });
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timeout = setTimeout(() => {
    log.debug(`${options.description} timed out`, options.category, { timeoutMs });
    worker.terminate().catch((error: unknown) => {
      log.debug(`${options.description} termination failed`, options.category, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, timeoutMs);
  timeout.unref?.();
  worker.unref();
  worker.on("error", (error) => {
    log.debug(`${options.description} failed`, options.category, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  worker.on("exit", (code) => {
    clearTimeout(timeout);
    if (code === 0) return;
    log.debug(`${options.description} exited`, options.category, { code });
  });
  return worker;
}

if (!isMainThread) {
  try {
    const data = workerData as ExposeHotSnapshotWorkerData;
    if (data.kind === "project") {
      refreshProjectExposeHotSnapshots(data.projectRoot);
    } else {
      refreshGlobalExposeHotSnapshots(data.projects);
    }
    parentPort?.postMessage({ ok: true });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
