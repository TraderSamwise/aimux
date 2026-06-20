import { debug } from "../debug.js";
import { parseKeys } from "../key-parser.js";
import { renderGraveyardDetails, renderGraveyardScreen } from "../tui/screens/subscreen-renderers.js";
import { postToProjectService } from "./dashboard-control.js";
import { type GraveyardSelectableRow, type GraveyardViewModel } from "./graveyard-view-model.js";

type ArchivesHost = any;

export function showGraveyard(host: ArchivesHost): void {
  host.clearDashboardSubscreens();
  if (!isGraveyardViewModel(host.graveyardViewModel)) applyGraveyardPayload(host, emptyGraveyardPayload());
  host.graveyardWorktreeDeleteConfirm = null;
  clampGraveyardSelection(host);
  host.setDashboardScreen("graveyard");
  host.writeStatuslineFile();
  renderGraveyard(host);
  void refreshGraveyardEntriesFromService(host);
}

export function hydrateDashboardArchiveScreenState(host: ArchivesHost): void {
  if (host.isDashboardScreen?.("graveyard")) {
    void refreshGraveyardEntriesFromService(host);
  }
}

export function renderGraveyard(host: ArchivesHost): void {
  if (!isGraveyardViewModel(host.graveyardViewModel)) applyGraveyardPayload(host, emptyGraveyardPayload());
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
    .then(async () => {
      host.graveyardWorktreeDeleteConfirm = null;
      if (host.mode === "dashboard") {
        await refreshGraveyardEntriesFromService(host);
      } else {
        applyGraveyardPayload(host, emptyGraveyardPayload());
      }
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

function getSelectableGraveyardRows(host: ArchivesHost): GraveyardSelectableRow[] {
  if (!isGraveyardViewModel(host.graveyardViewModel)) applyGraveyardPayload(host, emptyGraveyardPayload());
  return host.graveyardViewModel.selectableRows;
}

function clampGraveyardSelection(host: ArchivesHost): void {
  const items = getSelectableGraveyardRows(host);
  if (typeof host.graveyardIndex !== "number" || Number.isNaN(host.graveyardIndex)) host.graveyardIndex = 0;
  if (host.graveyardIndex < 0) host.graveyardIndex = 0;
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
    host.graveyardWorktreeDeleteConfirm = null;
    if (host.mode === "dashboard") {
      await refreshGraveyardEntriesFromService(host);
    } else {
      applyGraveyardPayload(host, emptyGraveyardPayload());
    }
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

function emptyGraveyardPayload(): { entries: any[]; worktrees: any[]; viewModel: GraveyardViewModel } {
  return { entries: [], worktrees: [], viewModel: { rows: [], selectableRows: [] } };
}

function isGraveyardViewModel(value: any): value is GraveyardViewModel {
  return Boolean(value) && Array.isArray(value.rows) && Array.isArray(value.selectableRows);
}

function isGraveyardPayload(value: any): value is { entries: any[]; worktrees: any[]; viewModel: GraveyardViewModel } {
  return (
    Boolean(value) &&
    value.ok === true &&
    Array.isArray(value.entries) &&
    Array.isArray(value.worktrees) &&
    isGraveyardViewModel(value.viewModel)
  );
}

function applyGraveyardPayload(
  host: ArchivesHost,
  payload: { entries: any[]; worktrees: any[]; viewModel: GraveyardViewModel },
): void {
  host.graveyardEntries = payload.entries;
  host.worktreeGraveyardEntries = payload.worktrees;
  host.graveyardViewModel = payload.viewModel;
  clampGraveyardSelection(host);
}

export async function refreshGraveyardEntriesFromService(host: ArchivesHost): Promise<boolean> {
  if (typeof host.getFromProjectService !== "function") {
    if (!isGraveyardViewModel(host.graveyardViewModel)) applyGraveyardPayload(host, emptyGraveyardPayload());
    return false;
  }
  try {
    const res = await host.getFromProjectService("/graveyard", { timeoutMs: 3000 });
    if (!isGraveyardPayload(res)) throw new Error("invalid graveyard payload");
    applyGraveyardPayload(host, res);
    if (host.isDashboardScreen?.("graveyard")) {
      renderGraveyard(host);
    }
    return true;
  } catch (error) {
    if (!isGraveyardViewModel(host.graveyardViewModel)) applyGraveyardPayload(host, emptyGraveyardPayload());
    debug(
      `failed to refresh graveyard from service: ${error instanceof Error ? error.message : String(error)}`,
      "session",
    );
    return false;
  }
}

export function renderGraveyardDetailsForHost(host: ArchivesHost, width: number, height: number): string[] {
  return renderGraveyardDetails(host, width, height);
}
