import { commandKey, parseKeys } from "../key-parser.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { buildProjectTopology, type ProjectTopology } from "../project-topology.js";
import { renderTopologyScreen } from "../tui/screens/subscreen-renderers.js";

type TopologyHost = any;

function emptyTopology(): ProjectTopology {
  return buildProjectTopology({ projectName: "project", worktrees: [] });
}

function applyTopology(host: TopologyHost, topology: ProjectTopology): void {
  host.topology = topology;
  host.topologyLoaded = true;
  const len = host.topology.rows.length;
  if (typeof host.topologyIndex !== "number" || Number.isNaN(host.topologyIndex)) host.topologyIndex = 0;
  if (host.topologyIndex < 0) host.topologyIndex = 0;
  if (host.topologyIndex >= len) host.topologyIndex = Math.max(0, len - 1);
}

function ensureTopology(host: TopologyHost): void {
  if (!host.topologyLoaded) applyTopology(host, emptyTopology());
}

function isTopologyHealth(value: any): boolean {
  return value === "active" || value === "attention" || value === "idle" || value === "offline";
}

function isTopologyWorktree(value: any): boolean {
  return (
    Boolean(value) &&
    typeof value.name === "string" &&
    typeof value.branch === "string" &&
    isTopologyHealth(value.health) &&
    typeof value.agents === "number" &&
    typeof value.services === "number" &&
    (value.path === undefined || typeof value.path === "string")
  );
}

function isTopologyRow(value: any): boolean {
  return (
    Boolean(value) &&
    (value.kind === "worktree" || value.kind === "agent" || value.kind === "service") &&
    typeof value.depth === "number" &&
    typeof value.label === "string" &&
    isTopologyHealth(value.health) &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.status === undefined || typeof value.status === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.serviceId === undefined || typeof value.serviceId === "string") &&
    (value.worktreePath === undefined || typeof value.worktreePath === "string")
  );
}

function isProjectTopology(value: any): value is ProjectTopology {
  return (
    Boolean(value) &&
    typeof value.projectName === "string" &&
    isTopologyHealth(value.health) &&
    value.counts &&
    typeof value.counts.worktrees === "number" &&
    typeof value.counts.agents === "number" &&
    typeof value.counts.services === "number" &&
    Array.isArray(value.worktrees) &&
    value.worktrees.every(isTopologyWorktree) &&
    Array.isArray(value.rows) &&
    value.rows.every(isTopologyRow)
  );
}

export async function refreshTopology(host: TopologyHost): Promise<boolean> {
  try {
    const res = await host.getFromProjectService(PROJECT_API_ROUTES.topology);
    if (!res?.ok || !isProjectTopology(res.topology)) throw new Error("invalid topology payload");
    applyTopology(host, res.topology);
    return true;
  } catch {
    ensureTopology(host);
    return false;
  }
}

export function showTopology(host: TopologyHost): void {
  host.clearDashboardSubscreens();
  ensureTopology(host);
  host.setDashboardScreen("topology");
  host.writeStatuslineFile();
  renderTopology(host);
  void refreshTopology(host).then((refreshed) => {
    if (refreshed && host.isDashboardScreen?.("topology")) renderTopology(host);
  });
}

export function renderTopology(host: TopologyHost): void {
  ensureTopology(host);
  renderTopologyScreen(host);
}

function findTopologySession(host: TopologyHost, sessionId: string): any | undefined {
  return (
    host.getDashboardSessions?.().find((entry: any) => entry.id === sessionId) ??
    (host.dashboardTeammatesCache ?? []).find((entry: any) => entry.id === sessionId)
  );
}

export function handleTopologyKey(host: TopologyHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = commandKey(event);
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderTopology(host);
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
  if (host.handleDashboardSubscreenNavigationKey(key, "topology")) return;
  if (key === "?") {
    host.showHelp();
    return;
  }
  if (key === "r") {
    void refreshTopology(host).then(() => {
      if (host.isDashboardScreen?.("topology")) renderTopology(host);
    });
    return;
  }
  const rows = host.topology?.rows ?? [];
  if (key === "down" || key === "j") {
    if (rows.length > 1) {
      host.topologyIndex = (host.topologyIndex + 1) % rows.length;
      renderTopology(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (rows.length > 1) {
      host.topologyIndex = (host.topologyIndex - 1 + rows.length) % rows.length;
      renderTopology(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < rows.length) {
      host.topologyIndex = idx;
      renderTopology(host);
    }
    return;
  }
  if (key === "enter" || key === "return") {
    const row = rows[host.topologyIndex];
    if (!row) return;
    if (row.sessionId) {
      const session = findTopologySession(host, row.sessionId);
      if (session) void host.activateDashboardEntry(session, { preserveDashboardSelection: Boolean(session.team) });
      return;
    }
    if (row.serviceId) {
      const service = host.getDashboardServices?.().find((entry: any) => entry.id === row.serviceId);
      if (service) void host.activateDashboardService(service);
    }
  }
}
