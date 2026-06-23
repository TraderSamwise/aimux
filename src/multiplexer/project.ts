import { buildProjectObservability, type ProjectObservability } from "../project-observability.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { renderProjectScreen } from "../tui/screens/subscreen-renderers.js";
import { commandKey, parseKeys } from "../key-parser.js";
import { getOrCreateTuiApiRuntime } from "./tui-api-runtime.js";
import {
  isDashboardLifecycleCurrent,
  startDashboardLifecycleTask,
  type DashboardApiViewRefreshOptions,
} from "./dashboard-lifecycle.js";

type ProjectHost = any;
const PROJECT_OBSERVABILITY_RESOURCE = "project-observability";

function emptyProjectObservability(): ProjectObservability {
  return buildProjectObservability({ sessions: [], services: [], worktrees: [], tasks: [], notifications: [] });
}

function applyProjectObservability(host: ProjectHost, project: ProjectObservability): void {
  host.projectObservability = project;
  host.projectObservabilityLoaded = true;
  const storyLength = host.projectObservability.story.length;
  if (typeof host.projectIndex !== "number" || Number.isNaN(host.projectIndex)) host.projectIndex = 0;
  if (host.projectIndex < 0) host.projectIndex = 0;
  if (host.projectIndex >= storyLength) host.projectIndex = Math.max(0, storyLength - 1);
}

function ensureProjectObservability(host: ProjectHost): void {
  if (!host.projectObservabilityLoaded) applyProjectObservability(host, emptyProjectObservability());
}

function isProjectSummary(value: any): boolean {
  return (
    value &&
    typeof value.agentsRunning === "number" &&
    typeof value.agentsWaiting === "number" &&
    typeof value.agentsOffline === "number" &&
    typeof value.services === "number" &&
    typeof value.worktrees === "number" &&
    typeof value.openTasks === "number" &&
    typeof value.doneTasks === "number" &&
    typeof value.unreadNotifications === "number"
  );
}

function isTaskProgress(value: any): boolean {
  return (
    value &&
    typeof value.pending === "number" &&
    typeof value.assigned === "number" &&
    typeof value.in_progress === "number" &&
    typeof value.blocked === "number" &&
    typeof value.done === "number" &&
    typeof value.failed === "number" &&
    typeof value.total === "number"
  );
}

function isProjectStoryItem(value: any): boolean {
  return (
    Boolean(value) &&
    typeof value.id === "string" &&
    (value.kind === "task" || value.kind === "review" || value.kind === "notification") &&
    typeof value.title === "string" &&
    typeof value.meta === "string" &&
    typeof value.createdAt === "string" &&
    (value.body === undefined || typeof value.body === "string") &&
    (value.status === undefined || typeof value.status === "string")
  );
}

function isProjectObservability(value: any): value is ProjectObservability {
  return (
    Boolean(value) &&
    isProjectSummary(value.summary) &&
    isTaskProgress(value.progress) &&
    Array.isArray(value.story) &&
    value.story.every(isProjectStoryItem)
  );
}

function validateProjectPayload(value: unknown): ProjectObservability {
  const res = value as any;
  if (!res?.ok || !isProjectObservability(res.project)) throw new Error("invalid project payload");
  return res.project;
}

export async function refreshProjectObservability(
  host: ProjectHost,
  options: DashboardApiViewRefreshOptions = {},
): Promise<boolean> {
  if (typeof host.getFromProjectService !== "function") {
    if (options.lifecycle && !isDashboardLifecycleCurrent(host, options.lifecycle)) return false;
    ensureProjectObservability(host);
    return false;
  }
  try {
    const result = await getOrCreateTuiApiRuntime(host).refreshJson(
      PROJECT_OBSERVABILITY_RESOURCE,
      PROJECT_API_ROUTES.projectObservability,
      validateProjectPayload,
      { supersede: options.force },
    );
    if (options.lifecycle && !isDashboardLifecycleCurrent(host, options.lifecycle)) return false;
    if (!result.ok || !result.value) {
      ensureProjectObservability(host);
      return false;
    }
    applyProjectObservability(host, result.value);
    return true;
  } catch {
    if (options.lifecycle && !isDashboardLifecycleCurrent(host, options.lifecycle)) return false;
    ensureProjectObservability(host);
    return false;
  }
}

export function showProject(host: ProjectHost): void {
  host.clearDashboardSubscreens();
  ensureProjectObservability(host);
  host.setDashboardScreen("project");
  host.writeStatuslineFile();
  renderProject(host);
  startDashboardLifecycleTask(host, { screen: "project" }, (lifecycle) => refreshProjectObservability(host, { lifecycle }), {
    onSuccess: (refreshed) => {
      if (refreshed) renderProject(host);
    },
  });
}

export function renderProject(host: ProjectHost): void {
  ensureProjectObservability(host);
  renderProjectScreen(host);
}

export function handleProjectKey(host: ProjectHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = commandKey(event);
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderProject(host);
    return;
  }
  if (key === "q") {
    host.exitDashboardClientOrProcess();
    return;
  }
  if (key === "escape" || key === "d") {
    host.setDashboardScreen("dashboard");
    host.renderDashboard();
    return;
  }
  if (host.handleDashboardSubscreenNavigationKey(key, "project")) return;
  if (key === "?") {
    host.showHelp();
    return;
  }
  const story = host.projectObservability?.story ?? [];
  if (key === "r") {
    startDashboardLifecycleTask(
      host,
      { screen: "project" },
      (lifecycle) => refreshProjectObservability(host, { force: true, lifecycle }),
      {
        onSuccess: () => renderProject(host),
      },
    );
    return;
  }
  if (key === "down" || key === "j") {
    if (story.length > 1) {
      host.projectIndex = (host.projectIndex + 1) % story.length;
      renderProject(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (story.length > 1) {
      host.projectIndex = (host.projectIndex - 1 + story.length) % story.length;
      renderProject(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < story.length) {
      host.projectIndex = idx;
      renderProject(host);
    }
  }
}
