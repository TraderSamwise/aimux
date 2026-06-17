import { debug } from "../debug.js";
import { parseKeys } from "../key-parser.js";
import { loadLastUsedState } from "../last-used.js";
import { renderGraveyardDetails, renderGraveyardScreen } from "../tui/screens/subscreen-renderers.js";
import { listWorktreeGraveyardEntries, type WorktreeGraveyardEntry } from "./worktree-graveyard.js";
import { postToProjectService } from "./dashboard-control.js";
import { requestJson } from "../http-client.js";
import { resolveProjectServiceEndpoint } from "../metadata-store.js";
import {
  buildGraveyardViewModel,
  type GraveyardSelectableRow,
  type GraveyardViewModel,
} from "./graveyard-view-model.js";
import { listTopologySessionStates } from "../runtime-core/topology-sessions.js";

type ArchivesHost = any;

export function showGraveyard(host: ArchivesHost): void {
  host.clearDashboardSubscreens();
  loadGraveyardEntries(host);
  host.graveyardWorktreeDeleteConfirm = null;
  clampGraveyardSelection(host);
  host.setDashboardScreen("graveyard");
  host.writeStatuslineFile();
  renderGraveyard(host);
  if (host.mode === "dashboard") {
    void refreshGraveyardEntriesFromService(host);
  }
}

export function hydrateDashboardArchiveScreenState(host: ArchivesHost): void {
  if (host.isDashboardScreen?.("graveyard")) {
    loadGraveyardEntries(host);
    if (host.mode === "dashboard") {
      void refreshGraveyardEntriesFromService(host);
    }
  }
}

export function renderGraveyard(host: ArchivesHost): void {
  refreshGraveyardViewModel(host);
  renderGraveyardScreen(host);
}

export function handleGraveyardKey(host: ArchivesHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderGraveyard(host);
    return;
  }

  if (host.graveyardWorktreeDeleteConfirm) {
    if (key === "escape" || key === "n") {
      host.graveyardWorktreeDeleteConfirm = null;
      renderGraveyard(host);
      return;
    }
    if (key === "y" || key === "enter" || key === "return") {
      void deleteSelectedGraveyardWorktree(host);
      return;
    }
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
  if (host.handleDashboardSubscreenNavigationKey(key, "graveyard")) return;

  if (key === "?") {
    host.showHelp();
    return;
  }

  if (key === "down" || key === "j") {
    const items = getSelectableGraveyardRows(host);
    if (items.length > 1) {
      host.graveyardIndex = (host.graveyardIndex + 1) % items.length;
      renderGraveyard(host);
    }
    return;
  }

  if (key === "up" || key === "k") {
    const items = getSelectableGraveyardRows(host);
    if (items.length > 1) {
      host.graveyardIndex = (host.graveyardIndex - 1 + items.length) % items.length;
      renderGraveyard(host);
    }
    return;
  }

  if (key >= "1" && key <= "9") {
    resurrectGraveyardEntry(host, parseInt(key) - 1);
    return;
  }

  if (key === "x") {
    const item = getSelectableGraveyardRows(host)[host.graveyardIndex];
    if (item?.kind === "worktree") {
      host.graveyardWorktreeDeleteConfirm = item.entry;
      renderGraveyard(host);
    }
    return;
  }

  if (key === "enter" || key === "return") {
    resurrectGraveyardEntry(host, host.graveyardIndex);
  }
}

export function resurrectGraveyardEntry(host: ArchivesHost, idx: number): void {
  const item = getSelectableGraveyardRows(host)[idx];
  if (!item) return;
  const promise =
    item.kind === "worktree"
      ? host.mode === "dashboard"
        ? postToProjectService(host, "/graveyard/worktrees/resurrect", { path: item.entry.path }, { timeoutMs: 10_000 })
        : host.resurrectGraveyardWorktree(item.entry.path)
      : host.mode === "dashboard"
        ? postToProjectService(host, "/graveyard/resurrect", { sessionId: item.entry.id }, { timeoutMs: 10_000 })
        : host.resurrectGraveyardSession(item.entry.id);
  void promise
    .then(() => {
      host.graveyardEntries = host.listGraveyardEntries();
      host.worktreeGraveyardEntries = host.listWorktreeGraveyardEntries();
      host.graveyardWorktreeDeleteConfirm = null;
      refreshGraveyardViewModel(host);
      if (getSelectableGraveyardRows(host).length === 0) {
        host.setDashboardScreen("dashboard");
        if (host.mode === "dashboard") {
          host.renderDashboard();
        } else {
          host.focusSession(host.activeIndex);
        }
        return;
      }

      clampGraveyardSelection(host);
      renderGraveyard(host);
    })
    .catch((error: unknown) => {
      debug(
        `failed to resurrect ${item.kind === "worktree" ? item.entry.path : item.entry.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "session",
      );
    });
}

function refreshGraveyardViewModel(host: ArchivesHost): GraveyardViewModel {
  const lastUsedState = loadLastUsedState(process.cwd());
  const viewModel = buildGraveyardViewModel({
    worktrees: host.worktreeGraveyardEntries ?? [],
    agents: host.graveyardEntries ?? [],
    parentSessions: [...(host.dashboardSessionsCache ?? []), ...(host.sessions ?? []), ...(host.offlineSessions ?? [])],
    teammates: [...(host.dashboardTeammatesCache ?? []), ...(host.sessions ?? []), ...(host.offlineSessions ?? [])],
    lastUsedById: lastUsedState.items,
  });
  host.graveyardViewModel = viewModel;
  return viewModel;
}

function getSelectableGraveyardRows(host: ArchivesHost): GraveyardSelectableRow[] {
  return (host.graveyardViewModel ?? refreshGraveyardViewModel(host)).selectableRows;
}

function clampGraveyardSelection(host: ArchivesHost): void {
  const items = getSelectableGraveyardRows(host);
  if (host.graveyardIndex >= items.length) {
    host.graveyardIndex = Math.max(0, items.length - 1);
  }
}

async function deleteSelectedGraveyardWorktree(host: ArchivesHost): Promise<void> {
  const entry = host.graveyardWorktreeDeleteConfirm;
  if (!entry) return;
  try {
    if (host.mode === "dashboard") {
      await postToProjectService(host, "/graveyard/worktrees/delete", { path: entry.path }, { timeoutMs: 10_000 });
    } else {
      await host.deleteGraveyardWorktree(entry.path);
    }
    host.worktreeGraveyardEntries = host.listWorktreeGraveyardEntries();
    host.graveyardEntries = host.listGraveyardEntries();
    host.graveyardWorktreeDeleteConfirm = null;
    refreshGraveyardViewModel(host);
    clampGraveyardSelection(host);
    if (getSelectableGraveyardRows(host).length === 0) {
      host.setDashboardScreen("dashboard");
      host.renderDashboard();
      return;
    }
    renderGraveyard(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.showDashboardError(`Failed to delete "${entry.name}"`, [message]);
  }
}

function loadGraveyardEntries(host: ArchivesHost): void {
  host.graveyardEntries = listTopologySessionStates({ statuses: ["graveyard"] });
  host.worktreeGraveyardEntries = listWorktreeGraveyardEntries();
  refreshGraveyardViewModel(host);
}

async function refreshGraveyardEntriesFromService(host: ArchivesHost): Promise<void> {
  const endpoint = resolveProjectServiceEndpoint(process.cwd());
  if (!endpoint) return;
  try {
    const { status, json } = await requestJson<{ ok?: boolean; entries?: any[]; worktrees?: WorktreeGraveyardEntry[] }>(
      `http://${endpoint.host}:${endpoint.port}/graveyard`,
      { timeoutMs: 3000 },
    );
    if (status < 200 || status >= 300 || json?.ok !== true) return;
    host.graveyardEntries = Array.isArray(json.entries) ? json.entries : [];
    host.worktreeGraveyardEntries = Array.isArray(json.worktrees) ? json.worktrees : [];
    refreshGraveyardViewModel(host);
    clampGraveyardSelection(host);
    if (host.isDashboardScreen?.("graveyard")) {
      renderGraveyard(host);
    }
  } catch (error) {
    debug(
      `failed to refresh graveyard from service: ${error instanceof Error ? error.message : String(error)}`,
      "session",
    );
  }
}

export function renderGraveyardDetailsForHost(host: ArchivesHost, width: number, height: number): string[] {
  return renderGraveyardDetails(host, width, height);
}
