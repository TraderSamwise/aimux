import { debug } from "../debug.js";
import { commandKey, parseKeys } from "../key-parser.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { renderGraveyardDetails, renderGraveyardScreen } from "../tui/screens/subscreen-renderers.js";
import { postToProjectService as postToProjectServiceTransport } from "./dashboard-control.js";
import {
  captureDashboardLifecycle,
  type DashboardLifecycleToken,
  isDashboardLifecycleCurrent,
} from "./dashboard-lifecycle.js";
import { type GraveyardSelectableRow, type GraveyardViewModel } from "./graveyard-view-model.js";
import { getOrCreateTuiApiRuntime, postJsonWithTuiApiRuntime } from "./tui-api-runtime.js";

type ArchivesHost = any;
interface ApiViewRefreshOptions {
  force?: boolean;
  lifecycle?: DashboardLifecycleToken;
  renderLifecycle?: DashboardLifecycleToken;
}
const GRAVEYARD_RESOURCE = "graveyard";

function postGraveyardMutation(
  host: ArchivesHost,
  path: string,
  body: unknown,
  opts?: { timeoutMs?: number },
): Promise<any> {
  return postJsonWithTuiApiRuntime(host, path, body, opts, postToProjectServiceTransport);
}

export function showGraveyard(host: ArchivesHost): void {
  host.clearDashboardSubscreens();
  if (!isGraveyardViewModel(host.graveyardViewModel)) applyGraveyardPayload(host, emptyGraveyardPayload());
  host.graveyardWorktreeDeleteConfirm = null;
  clampGraveyardSelection(host);
  host.setDashboardScreen("graveyard");
  host.writeStatuslineFile();
  renderGraveyard(host);
  const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true, screen: "graveyard" });
  void refreshGraveyardEntriesFromService(host, { lifecycle });
}

export function hydrateDashboardArchiveScreenState(host: ArchivesHost): void {
  if (host.isDashboardScreen?.("graveyard")) {
    const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true, screen: "graveyard" });
    void refreshGraveyardEntriesFromService(host, { lifecycle });
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
  const key = commandKey(event);
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
  const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true, screen: "graveyard" });
  const promise =
    item.kind === "worktree"
      ? host.mode === "dashboard"
        ? postGraveyardMutation(
            host,
            PROJECT_API_ROUTES.graveyardActions.resurrectWorktree,
            { path: item.entry.path },
            { timeoutMs: 10_000 },
          )
        : host.resurrectGraveyardWorktree(item.entry.path)
      : host.mode === "dashboard"
        ? postGraveyardMutation(
            host,
            PROJECT_API_ROUTES.graveyardActions.resurrectAgent,
            { sessionId: item.entry.id },
            { timeoutMs: 10_000 },
          )
        : host.resurrectGraveyardSession(item.entry.id);
  void promise
    .then(async () => {
      if (host.mode === "dashboard") {
        if (!(await refreshGraveyardEntriesFromService(host, { force: true, renderLifecycle: lifecycle }))) {
          throw new Error("graveyard snapshot unavailable after resurrection");
        }
        await refreshDashboardAfterGraveyardMutation(host);
      } else {
        applyGraveyardPayload(host, emptyGraveyardPayload());
      }
      if (lifecycle.mode === "dashboard" && !isDashboardLifecycleCurrent(host, lifecycle)) return;
      host.graveyardWorktreeDeleteConfirm = null;
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
      const label = item.kind === "worktree" ? item.entry.path : item.entry.id;
      const message = error instanceof Error ? error.message : String(error);
      debug(`failed to resurrect ${label}: ${message}`, "session");
      if (lifecycle.mode === "dashboard" && !isDashboardLifecycleCurrent(host, lifecycle)) return;
      host.showDashboardError?.(`Failed to resurrect "${label}"`, [message]);
      if (host.mode === "dashboard") {
        void refreshGraveyardEntriesFromService(host, { force: true, renderLifecycle: lifecycle });
        void refreshDashboardAfterGraveyardMutation(host);
      }
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
  const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true, screen: "graveyard" });
  try {
    if (host.mode === "dashboard") {
      await postGraveyardMutation(
        host,
        PROJECT_API_ROUTES.graveyardActions.deleteWorktree,
        { path: entry.path },
        { timeoutMs: 10_000 },
      );
    } else {
      await host.deleteGraveyardWorktree(entry.path);
    }
    if (host.mode === "dashboard") {
      if (!(await refreshGraveyardEntriesFromService(host, { force: true, renderLifecycle: lifecycle }))) {
        throw new Error("graveyard snapshot unavailable after delete");
      }
      await refreshDashboardAfterGraveyardMutation(host);
    } else {
      applyGraveyardPayload(host, emptyGraveyardPayload());
    }
    clampGraveyardSelection(host);
    if (lifecycle.mode === "dashboard" && !isDashboardLifecycleCurrent(host, lifecycle)) return;
    if (host.graveyardWorktreeDeleteConfirm === entry) host.graveyardWorktreeDeleteConfirm = null;
    if (getSelectableGraveyardRows(host).length === 0) {
      host.setDashboardScreen("dashboard");
      host.renderDashboard();
      return;
    }
    renderGraveyard(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (lifecycle.mode === "dashboard" && !isDashboardLifecycleCurrent(host, lifecycle)) return;
    if (host.graveyardWorktreeDeleteConfirm === entry) host.graveyardWorktreeDeleteConfirm = null;
    host.showDashboardError(`Failed to delete "${entry.name}"`, [message]);
    if (host.mode === "dashboard") {
      void refreshGraveyardEntriesFromService(host, { force: true, renderLifecycle: lifecycle });
      void refreshDashboardAfterGraveyardMutation(host);
    }
  }
}

function emptyGraveyardPayload(): { entries: any[]; worktrees: any[]; viewModel: GraveyardViewModel } {
  return { entries: [], worktrees: [], viewModel: { rows: [], selectableRows: [] } };
}

async function refreshDashboardAfterGraveyardMutation(host: ArchivesHost): Promise<void> {
  if (host.mode !== "dashboard") return;
  if (typeof host.refreshDashboardModelFromService === "function") {
    await host.refreshDashboardModelFromService(true).catch(() => false);
  }
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

function validateGraveyardPayload(value: unknown): { entries: any[]; worktrees: any[]; viewModel: GraveyardViewModel } {
  if (!isGraveyardPayload(value)) throw new Error("invalid graveyard payload");
  return value;
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

export async function refreshGraveyardEntriesFromService(
  host: ArchivesHost,
  options: ApiViewRefreshOptions = {},
): Promise<boolean> {
  if (typeof host.getFromProjectService !== "function") {
    if (isRefreshLifecycleCurrent(host, options) && !isGraveyardViewModel(host.graveyardViewModel)) {
      applyGraveyardPayload(host, emptyGraveyardPayload());
    }
    return false;
  }
  try {
    const result = await getOrCreateTuiApiRuntime(host).refreshJson(
      GRAVEYARD_RESOURCE,
      PROJECT_API_ROUTES.graveyard,
      validateGraveyardPayload,
      { timeoutMs: 3000, supersede: options.force },
    );
    if (!result.ok || !result.value) {
      if (isRefreshLifecycleCurrent(host, options) && !isGraveyardViewModel(host.graveyardViewModel)) {
        applyGraveyardPayload(host, emptyGraveyardPayload());
      }
      return false;
    }
    applyGraveyardPayload(host, result.value);
    if (isRefreshRenderLifecycleCurrent(host, options) && host.isDashboardScreen?.("graveyard")) {
      renderGraveyard(host);
    }
    return true;
  } catch (error) {
    if (isRefreshLifecycleCurrent(host, options) && !isGraveyardViewModel(host.graveyardViewModel)) {
      applyGraveyardPayload(host, emptyGraveyardPayload());
    }
    debug(
      `failed to refresh graveyard from service: ${error instanceof Error ? error.message : String(error)}`,
      "session",
    );
    return false;
  }
}

function isRefreshLifecycleCurrent(host: ArchivesHost, options: ApiViewRefreshOptions): boolean {
  return !options.lifecycle || isDashboardLifecycleCurrent(host, options.lifecycle);
}

function isRefreshRenderLifecycleCurrent(host: ArchivesHost, options: ApiViewRefreshOptions): boolean {
  const lifecycle = options.renderLifecycle ?? options.lifecycle;
  return !lifecycle || isDashboardLifecycleCurrent(host, lifecycle);
}

export function renderGraveyardDetailsForHost(host: ArchivesHost, width: number, height: number): string[] {
  return renderGraveyardDetails(host, width, height);
}
