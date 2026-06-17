import { listNotifications } from "../notifications.js";
import { buildProjectObservability } from "../project-observability.js";
import { readAllTasks } from "../tasks.js";
import { renderProjectScreen } from "../tui/screens/subscreen-renderers.js";
import { parseKeys } from "../key-parser.js";

type ProjectHost = any;

function refreshProjectObservability(host: ProjectHost): void {
  const sessions = host.getDashboardSessions?.() ?? [];
  const services = host.getDashboardServices?.() ?? [];
  const worktrees = host.dashboardWorktreeGroupsCache ?? [];
  host.projectObservability = buildProjectObservability({
    sessions,
    services,
    worktrees,
    tasks: readAllTasks(),
    notifications: listNotifications(),
  });
  const storyLength = host.projectObservability.story.length;
  if (typeof host.projectIndex !== "number" || Number.isNaN(host.projectIndex)) host.projectIndex = 0;
  if (host.projectIndex >= storyLength) host.projectIndex = Math.max(0, storyLength - 1);
}

export function showProject(host: ProjectHost): void {
  host.clearDashboardSubscreens();
  refreshProjectObservability(host);
  host.setDashboardScreen("project");
  host.writeStatuslineFile();
  renderProject(host);
}

export function renderProject(host: ProjectHost): void {
  refreshProjectObservability(host);
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
    refreshProjectObservability(host);
    renderProject(host);
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
