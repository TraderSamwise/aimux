import { buildProjectObservability, type ProjectObservability } from "../project-observability.js";
import { renderProjectScreen } from "../tui/screens/subscreen-renderers.js";
import { parseKeys } from "../key-parser.js";

type ProjectHost = any;

function emptyProjectObservability(): ProjectObservability {
  return buildProjectObservability({ sessions: [], services: [], worktrees: [], tasks: [], notifications: [] });
}

function applyProjectObservability(host: ProjectHost, project: ProjectObservability): void {
  host.projectObservability = project;
  const storyLength = host.projectObservability.story.length;
  if (typeof host.projectIndex !== "number" || Number.isNaN(host.projectIndex)) host.projectIndex = 0;
  if (host.projectIndex < 0) host.projectIndex = 0;
  if (host.projectIndex >= storyLength) host.projectIndex = Math.max(0, storyLength - 1);
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

function isProjectObservability(value: any): value is ProjectObservability {
  return (
    Boolean(value) &&
    isProjectSummary(value.summary) &&
    isTaskProgress(value.progress) &&
    Array.isArray(value.story)
  );
}

export async function refreshProjectObservability(host: ProjectHost): Promise<boolean> {
  try {
    const res = await host.getFromProjectService("/project-observability");
    if (!res?.ok || !isProjectObservability(res.project)) throw new Error("invalid project payload");
    applyProjectObservability(host, res.project);
    return true;
  } catch {
    if (!host.projectObservability) applyProjectObservability(host, emptyProjectObservability());
    return false;
  }
}

export function showProject(host: ProjectHost): void {
  host.clearDashboardSubscreens();
  if (!host.projectObservability) applyProjectObservability(host, emptyProjectObservability());
  host.setDashboardScreen("project");
  host.writeStatuslineFile();
  renderProject(host);
  void refreshProjectObservability(host).then((refreshed) => {
    if (refreshed && host.isDashboardScreen?.("project")) renderProject(host);
  });
}

export function renderProject(host: ProjectHost): void {
  if (!host.projectObservability) applyProjectObservability(host, emptyProjectObservability());
  renderProjectScreen(host);
}

export function handleProjectKey(host: ProjectHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;
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
    void refreshProjectObservability(host).then(() => {
      if (host.isDashboardScreen?.("project")) renderProject(host);
    });
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
