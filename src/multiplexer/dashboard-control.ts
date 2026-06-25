import { writeTextAtomic } from "../atomic-write.js";
import { debug } from "../debug.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardService, DashboardSession, DashboardWorktreeEntry } from "../dashboard/index.js";
import type { DashboardScreen } from "../dashboard/state.js";
import { isHttpTimeoutError, requestJson } from "../http-client.js";
import { markLastUsed } from "../last-used.js";
import { loadMetadataEndpoint, removeMetadataEndpoint } from "../metadata-store.js";
import { commandKey, parseKeys } from "../key-parser.js";
import { ensureDaemonRunning, ensureProjectService, stopProjectService } from "../daemon.js";
import { getGlobalAimuxDir, getProjectStateDirFor } from "../paths.js";
import { getProjectServiceManifest, manifestsMatch, type ProjectServiceManifest } from "../project-service-manifest.js";
import { isOverseerSession } from "../team.js";
import { loadStatusline, renderTmuxStatuslineFromData } from "../tmux/statusline.js";
import { openManagedServiceWindow, openManagedSessionWindow } from "../tmux/window-open.js";
import { PROJECT_API_ROUTES, type OrchestrationRouteOption } from "../project-api-contract.js";
import { sortDashboardEntriesByCreatedAt } from "../dashboard/sort.js";
import {
  buildDashboardBusyOverlayOutput,
  buildDashboardErrorOverlayOutput,
  buildDashboardRuntimeGuardOverlayOutput,
  buildLabelInputOverlayOutput,
  buildMigratePickerOverlayOutput,
  buildServiceInputOverlayOutput,
  buildSwitcherOverlayOutput,
  buildTeammatePickerOverlayOutput,
  buildWorktreeListOverlayOutput,
  buildWorktreeRemoveConfirmOverlayOutput,
  hints,
} from "../tui/screens/overlay-renderers.js";
import { renderOverlayBox } from "../tui/render/box.js";
import { keycap, style } from "../tui/render/theme.js";
import { buildWorktreeInputOverlayOutput } from "./worktrees.js";
import { buildToolOptionsOverlayOutput, buildToolPickerOverlayOutput } from "./tool-picker.js";
import { buildThreadReplyOverlayOutput } from "./subscreens.js";
import {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  renderDashboardIfCurrent,
  type DashboardLifecycleToken,
} from "./dashboard-lifecycle.js";
import { mutateDashboardApi, refreshDashboardModelThroughApi } from "./dashboard-api-client.js";
import { queueTuiNotificationContext, queueTuiSessionSeen } from "./tui-runtime-mutations.js";
import {
  probeRuntimeGuard,
  runtimeGuardEquals,
  runtimeGuardKeyDisposition,
  stabilizeRuntimeGuardProbe,
  type RuntimeGuardState,
} from "./runtime-guard.js";
import { getJsonWithTuiApiRuntime } from "./tui-api-runtime.js";

type DashboardControlHost = any;
type DashboardOrchestrationTarget = OrchestrationRouteOption;
const RUNTIME_GUARD_REPAIR_LOCK_STALE_MS = 120_000;
const RUNTIME_GUARD_REPAIR_TIMEOUT_MS = 45_000;
const RUNTIME_GUARD_REPAIR_KILL_GRACE_MS = 5_000;
const RUNTIME_GUARD_REPAIR_RETRY_MS = 5_000;
const PROJECT_SERVICE_ENDPOINT_HEALTH_CACHE_MS = 30_000;
type ProjectServiceEndpointState = "current" | "stale" | "unknown";

export function dashboardProjectRoot(host: DashboardControlHost): string {
  const projectRoot = typeof host.projectRoot === "string" ? host.projectRoot.trim() : "";
  return projectRoot || process.cwd();
}

export class DashboardProjectServiceHttpError extends Error {
  readonly tuiApiRecoverable: boolean;

  constructor(
    readonly status: number,
    readonly response: unknown,
    message: string,
  ) {
    super(message);
    this.name = "DashboardProjectServiceHttpError";
    this.tuiApiRecoverable = isProjectServiceRetryableStatus(status) || status >= 500;
  }
}

function writeStatuslineTextFile(projectRoot: string, name: string, content: string): void {
  // Cosmetic tmux chrome written concurrently by multiple clients/refreshes:
  // unique-temp atomic write (never a shared ".tmp"), and never fatal.
  try {
    writeTextAtomic(join(getProjectStateDirFor(projectRoot), "tmux-statusline", name), `${content}\n`);
  } catch (error) {
    debug(
      `statusline write failed for ${name}: ${error instanceof Error ? error.message : String(error)}`,
      "statusline",
    );
  }
}

function primeLiveTmuxFooter(host: DashboardControlHost, target: { windowId: string; windowName: string }): void {
  try {
    const projectRoot = dashboardProjectRoot(host);
    const data = loadStatusline(projectRoot);
    if (!data) return;
    const currentPath =
      host.tmuxRuntimeManager.displayMessage("#{pane_current_path}", target.windowId) ?? projectRoot;
    const top = renderTmuxStatuslineFromData(data, projectRoot, "top", {
      currentWindow: target.windowName,
      currentWindowId: target.windowId,
      currentPath,
    });
    const bottom = renderTmuxStatuslineFromData(data, projectRoot, "bottom", {
      currentWindow: target.windowName,
      currentWindowId: target.windowId,
      currentPath,
    });
    writeStatuslineTextFile(projectRoot, `top-${target.windowId}.txt`, top);
    writeStatuslineTextFile(projectRoot, `bottom-${target.windowId}.txt`, bottom);
  } catch {}
}

export function updateWorktreeSessions(host: DashboardControlHost): void {
  const allDash = host.getDashboardSessions();
  host.dashboardState.worktreeSessions = host.dashboardUiStateStore.orderSessionsForWorktree(
    sortDashboardEntriesByCreatedAt(
      allDash.filter((s: DashboardSession) => {
        if (isOverseerSession(s)) return false;
        return (s.worktreePath ?? undefined) === host.dashboardState.focusedWorktreePath;
      }),
    ),
    host.dashboardState.focusedWorktreePath,
  );
  const filteredServices: DashboardService[] = host.getDashboardServices().filter((service: DashboardService) => {
    return (service.worktreePath ?? undefined) === host.dashboardState.focusedWorktreePath;
  });
  const worktreeServices = host.dashboardUiStateStore.orderServicesForWorktree(
    sortDashboardEntriesByCreatedAt(filteredServices),
    host.dashboardState.focusedWorktreePath,
  );
  host.dashboardState.worktreeEntries = [
    ...host.dashboardState.worktreeSessions.map(
      (session: DashboardSession) => ({ kind: "session", id: session.id }) as const,
    ),
    ...worktreeServices.map((service: DashboardService) => ({ kind: "service", id: service.id }) as const),
  ];
}

export function syncTuiNotificationContext(host: DashboardControlHost, panelOpen = false): void {
  if (host.mode !== "dashboard") return;
  const selected =
    host.dashboardState.level === "sessions" && host.dashboardState.worktreeEntries.length > 0
      ? host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex]?.kind === "session"
        ? host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex]?.id
        : undefined
      : host.getDashboardSessions()[host.activeIndex]?.id;
  noteTuiNotificationContext(host, {
    screen: host.dashboardState.screen,
    sessionId: selected,
    panelOpen,
  });
}

export function isDashboardScreen(host: DashboardControlHost, screen: DashboardScreen): boolean {
  return host.dashboardState.isScreen(screen);
}

export function setDashboardScreen(host: DashboardControlHost, screen: DashboardScreen): void {
  host.dashboardState.setScreen(screen);
  syncTuiNotificationContext(host, false);
  host.writeDashboardClientStatuslineFile();
  host.persistDashboardUiState();
  host.tmuxRuntimeManager.refreshStatus();
}

// Intercept keys while the dashboard is guarded: let safe nav keys through,
// swallow everything that could mutate. Returns true when the key was consumed.
export function handleRuntimeGuardKey(host: DashboardControlHost, data: Buffer): boolean {
  if (!host.runtimeGuardState || host.runtimeGuardState.kind === "ok") return false;
  if (host.dashboardBusyState || host.dashboardErrorState) return false;
  const overlayKind = host.dashboardOverlayState?.kind;
  if (overlayKind && overlayKind !== "none") return false;
  const events = parseKeys(data);
  // Unrecognized/empty sequences can't mutate (no handler acts on them); let them fall through
  // rather than eat them, so the guard only ever swallows actual recognized keystrokes.
  if (events.length === 0) return false;
  const key = commandKey(events[0]);
  const disposition = runtimeGuardKeyDisposition(key);
  if (disposition === "passthrough") return false;
  showDashboardFooterFlash(
    host,
    host.runtimeGuardState.kind === "disconnected"
      ? "Aimux is reconnecting to the project service"
      : "Aimux is repairing the local control plane",
    3,
  );
  host.renderCurrentDashboardView();
  return true;
}

function shouldAutoRepairRuntimeGuard(state: RuntimeGuardState): boolean {
  return state.kind === "stale" || state.kind === "runtime-rebuild-required";
}

function runtimeGuardRepairKey(state: RuntimeGuardState): string {
  return state.kind === "stale" ? `${state.kind}:${state.reason}` : state.kind;
}

function showDashboardFooterFlash(host: DashboardControlHost, message: string, ticks: number): void {
  host.footerFlash = message;
  host.footerFlashTicks = ticks;
}

function runtimeGuardRepairLockPath(): string {
  return join(getGlobalAimuxDir(), "locks", "dashboard-control-plane-repair");
}

function runtimeGuardRepairStealLockPath(): string {
  return join(getGlobalAimuxDir(), "locks", "dashboard-control-plane-repair.steal");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRuntimeGuardRepairLockPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function writeRuntimeGuardRepairLockOwner(lockPath: string, pid: number, projectRoot: string): void {
  writeFileSync(
    join(lockPath, "owner.json"),
    `${JSON.stringify({ pid, projectRoot, acquiredAt: new Date().toISOString() })}\n`,
  );
}

function tryAcquireRuntimeGuardRepairStealLock(): string | null {
  const stealPath = runtimeGuardRepairStealLockPath();
  const writeOwner = (): boolean => {
    try {
      writeFileSync(
        join(stealPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      );
      return true;
    } catch {
      rmSync(stealPath, { recursive: true, force: true });
      return false;
    }
  };
  try {
    mkdirSync(stealPath, { recursive: false });
    if (!writeOwner()) return null;
    return stealPath;
  } catch {
    try {
      if (Date.now() - statSync(stealPath).mtimeMs > RUNTIME_GUARD_REPAIR_LOCK_STALE_MS) {
        rmSync(stealPath, { recursive: true, force: true });
        mkdirSync(stealPath, { recursive: false });
        if (!writeOwner()) return null;
        return stealPath;
      }
    } catch {
      if (!existsSync(stealPath)) return tryAcquireRuntimeGuardRepairStealLock();
    }
    return null;
  }
}

function tryAcquireRuntimeGuardRepairLock(projectRoot: string): string | null {
  const lockPath = runtimeGuardRepairLockPath();
  const acquire = (): string | null => {
    try {
      mkdirSync(lockPath);
      try {
        writeRuntimeGuardRepairLockOwner(lockPath, process.pid, projectRoot);
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return lockPath;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      return null;
    }
  };

  mkdirSync(join(getGlobalAimuxDir(), "locks"), { recursive: true });
  const acquired = acquire();
  if (acquired) return acquired;
  try {
    const ownerPid = readRuntimeGuardRepairLockPid(lockPath);
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if ((ownerPid && !isPidAlive(ownerPid)) || (!ownerPid && ageMs > RUNTIME_GUARD_REPAIR_LOCK_STALE_MS)) {
      const stealPath = tryAcquireRuntimeGuardRepairStealLock();
      if (!stealPath) return null;
      try {
        const currentOwnerPid = readRuntimeGuardRepairLockPid(lockPath);
        const currentAgeMs = Date.now() - statSync(lockPath).mtimeMs;
        if (
          !(
            (currentOwnerPid && !isPidAlive(currentOwnerPid)) ||
            (!currentOwnerPid && currentAgeMs > RUNTIME_GUARD_REPAIR_LOCK_STALE_MS)
          )
        ) {
          return null;
        }
        rmSync(lockPath, { recursive: true, force: true });
        return acquire();
      } finally {
        rmSync(stealPath, { recursive: true, force: true });
      }
    }
  } catch {
    if (!existsSync(lockPath)) return acquire();
  }
  return null;
}

function releaseRuntimeGuardRepairLock(lockPath: string | null): void {
  if (!lockPath) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {}
}

function showRuntimeGuardRepairFailure(host: DashboardControlHost, title: string, message: string): void {
  if (host.runtimeGuardRepairBusy) {
    host.dashboardBusyState = null;
    host.runtimeGuardRepairBusy = false;
  }
  if (typeof host.showDashboardError === "function") {
    host.showDashboardError(title, [message]);
    return;
  }
  showDashboardFooterFlash(host, `${title}: ${message}`, 6);
  host.renderCurrentDashboardView?.();
}

function clearRuntimeGuardRepairError(host: DashboardControlHost): void {
  if (host.dashboardErrorState?.title === "Aimux repair failed") {
    host.dashboardErrorState = null;
  }
}

function describeRuntimeGuardState(state: RuntimeGuardState): string {
  if (state.kind === "ok") return "healthy";
  if (state.kind === "stale") return `out of sync (${state.reason})`;
  if (state.kind === "runtime-rebuild-required") return "runtime rebuild required";
  return "project service unreachable";
}

function runtimeGuardRepairRetryReady(host: DashboardControlHost, repairKey: string): boolean {
  const failedKey = host.runtimeGuardRepairFailedKey;
  if (failedKey !== repairKey) return true;
  const retryAt = host.runtimeGuardRepairRetryAt;
  if (typeof retryAt !== "number" || Date.now() < retryAt) return false;
  host.runtimeGuardRepairFailedKey = undefined;
  host.runtimeGuardRepairRetryAt = undefined;
  return true;
}

export function startRuntimeGuardRepair(host: DashboardControlHost, state: RuntimeGuardState): void {
  if (!shouldAutoRepairRuntimeGuard(state) || host.runtimeGuardRepairing) return;
  const lifecycle = captureDashboardLifecycle(host);
  const repairKey = runtimeGuardRepairKey(state);
  if (!runtimeGuardRepairRetryReady(host, repairKey)) return;
  const projectRoot = dashboardProjectRoot(host);
  const lockPath = tryAcquireRuntimeGuardRepairLock(projectRoot);
  if (!lockPath) {
    host.runtimeGuardRepairBusy = true;
    showDashboardFooterFlash(host, "Aimux repair already running", 3);
    renderDashboardIfCurrent(host, lifecycle, () => host.renderCurrentDashboardView?.());
    return;
  }
  const command = resolveDashboardReloadCommand();
  host.runtimeGuardRepairing = true;
  host.runtimeGuardRepairStateKey = repairKey;
  host.runtimeGuardRepairBusy = true;
  clearRuntimeGuardRepairError(host);
  host.dashboardBusyState = {
    title: "Repairing Aimux",
    lines: ["Aimux is repairing the local control plane."],
    spinnerFrame: 0,
    startedAt: Date.now(),
  };
  renderDashboardIfCurrent(host, lifecycle, () => host.renderCurrentDashboardView?.());

  let settled = false;
  let repairTimeout: ReturnType<typeof setTimeout> | null = null;
  let repairKillTimeout: ReturnType<typeof setTimeout> | null = null;
  let childExited = false;
  let releaseLockWhenChildExits = false;
  const clearRepairTimeout = () => {
    if (!repairTimeout) return;
    clearTimeout(repairTimeout);
    repairTimeout = null;
  };
  const clearRepairKillTimeout = () => {
    if (!repairKillTimeout) return;
    clearTimeout(repairKillTimeout);
    repairKillTimeout = null;
  };
  const fail = (message: string, options: { keepRepairLock?: boolean } = {}) => {
    if (settled) return;
    settled = true;
    clearRepairTimeout();
    if (!options.keepRepairLock) clearRepairKillTimeout();
    if (!options.keepRepairLock) releaseRuntimeGuardRepairLock(lockPath);
    host.runtimeGuardRepairing = false;
    host.runtimeGuardRepairFailedKey = repairKey;
    host.runtimeGuardRepairRetryAt = Date.now() + RUNTIME_GUARD_REPAIR_RETRY_MS;
    if (host.runtimeGuardRepairBusy) {
      host.dashboardBusyState = null;
      host.runtimeGuardRepairBusy = false;
    }
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    showRuntimeGuardRepairFailure(host, "Aimux repair failed", message);
  };
  const succeed = async () => {
    if (settled) return;
    const probed = await probeRuntimeGuard(projectRoot);
    if (settled) return;
    if (probed.kind !== "ok") {
      fail(`aimux repair completed but the control plane is still ${describeRuntimeGuardState(probed)}`);
      return;
    }
    if (isDashboardLifecycleCurrent(host, lifecycle)) {
      const refreshed = await refreshDashboardModelThroughApi(host, { force: true, lifecycle });
      if (settled) return;
      if (!refreshed) {
        fail("aimux repair completed but dashboard data is still unavailable");
        return;
      }
    }
    if (settled) return;
    settled = true;
    clearRepairTimeout();
    clearRepairKillTimeout();
    releaseRuntimeGuardRepairLock(lockPath);
    host.runtimeGuardRepairing = false;
    host.runtimeGuardRepairFailedKey = undefined;
    host.runtimeGuardRepairRetryAt = undefined;
    clearRuntimeGuardRepairError(host);
    if (host.runtimeGuardRepairBusy) {
      host.dashboardBusyState = null;
      host.runtimeGuardRepairBusy = false;
    }
    host.runtimeGuardState = { kind: "ok" };
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    host.renderCurrentDashboardView?.();
  };

  try {
    const child = spawn(command, ["restart", "--project", projectRoot], { detached: true, stdio: "ignore" });
    if (typeof child.pid === "number" && child.pid > 0) {
      writeRuntimeGuardRepairLockOwner(lockPath, child.pid, projectRoot);
    }
    repairTimeout = setTimeout(() => {
      if (!childExited) {
        releaseLockWhenChildExits = true;
        try {
          child.kill?.("SIGTERM");
        } catch {}
        repairKillTimeout = setTimeout(() => {
          repairKillTimeout = null;
          if (childExited) return;
          try {
            child.kill?.("SIGKILL");
          } catch {}
        }, RUNTIME_GUARD_REPAIR_KILL_GRACE_MS);
        repairKillTimeout.unref?.();
      }
      fail(`aimux repair timed out after ${Math.round(RUNTIME_GUARD_REPAIR_TIMEOUT_MS / 1000)}s`, {
        keepRepairLock: !childExited,
      });
    }, RUNTIME_GUARD_REPAIR_TIMEOUT_MS);
    repairTimeout.unref?.();
    child.on("error", (error) => fail(error instanceof Error ? error.message : String(error)));
    child.on("exit", (code, signal) => {
      childExited = true;
      clearRepairKillTimeout();
      if (releaseLockWhenChildExits) {
        releaseRuntimeGuardRepairLock(lockPath);
        releaseLockWhenChildExits = false;
      }
      if (code === 0) {
        void succeed().catch((error) => fail(error instanceof Error ? error.message : String(error)));
        return;
      }
      fail(signal ? `aimux repair exited on ${signal}` : `aimux repair exited with code ${code ?? "unknown"}`);
    });
    child.unref();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function refreshRuntimeGuard(host: DashboardControlHost): Promise<void> {
  if (host.mode !== "dashboard") return;
  if (host.runtimeGuardProbing) return;
  const lifecycle = captureDashboardLifecycle(host);
  host.runtimeGuardProbing = true;
  try {
    const current = host.runtimeGuardState ?? { kind: "ok" };
    const probed = await probeRuntimeGuard(dashboardProjectRoot(host));
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    const next = stabilizeRuntimeGuardProbe(current, probed, host.runtimeGuardDisconnectProbeCount ?? 0);
    host.runtimeGuardDisconnectProbeCount = next.disconnectedProbeCount;
    if (!runtimeGuardEquals(current, next.state)) {
      host.runtimeGuardState = next.state;
      if (next.state.kind === "ok") {
        host.runtimeGuardRepairFailedKey = undefined;
        host.runtimeGuardRepairRetryAt = undefined;
        clearRuntimeGuardRepairError(host);
        if (host.runtimeGuardRepairBusy && !host.runtimeGuardRepairing) {
          host.dashboardBusyState = null;
          host.runtimeGuardRepairBusy = false;
        }
      }
      host.renderCurrentDashboardView();
    }
    if (shouldAutoRepairRuntimeGuard(next.state)) startRuntimeGuardRepair(host, next.state);
  } finally {
    host.runtimeGuardProbing = false;
  }
}

export function resolveDashboardReloadCommand(): string {
  return process.env.AIMUX_CLI_BIN?.trim() || "aimux";
}

export function handleActiveDashboardOverlayKey(host: DashboardControlHost, data: Buffer): boolean {
  if (host.dashboardBusyState) {
    return true;
  }
  if (host.dashboardErrorState) {
    const events = parseKeys(data);
    if (events.length === 0) return true;
    const key = commandKey(events[0]);
    if (key === "escape" || key === "enter" || key === "return") {
      host.dismissDashboardError();
    }
    return true;
  }
  switch (host.dashboardOverlayState.kind) {
    case "tool-picker":
      host.handleToolPickerKey(data);
      return true;
    case "tool-options":
      host.handleToolOptionsKey(data);
      return true;
    case "teammate-picker":
      host.handleTeammatePickerKey(data);
      return true;
    case "worktree-remove-confirm":
      host.handleWorktreeRemoveConfirmKey(data);
      return true;
    case "worktree-input":
      host.handleWorktreeInputKey(data);
      return true;
    case "service-input":
      host.handleServiceInputKey(data);
      return true;
    case "worktree-list":
      host.handleWorktreeListKey(data);
      return true;
    case "migrate-picker":
      host.handleMigratePickerKey(data);
      return true;
    case "switcher":
      host.handleSwitcherKey(data);
      return true;
    case "thread-reply":
      host.handleThreadReplyKey(data);
      return true;
    case "orchestration-route-picker":
      host.handleOrchestrationRoutePickerKey(data);
      return true;
    case "orchestration-input":
      host.handleOrchestrationInputKey(data);
      return true;
    case "label-input":
      host.handleLabelInputKey(data);
      return true;
    default:
      return false;
  }
}

export function renderActiveDashboardOverlay(host: DashboardControlHost): boolean {
  if (!buildActiveDashboardOverlayOutput(host)) return false;
  host.redrawDashboardWithOverlay?.();
  return true;
}

export function buildActiveDashboardOverlayOutput(
  host: DashboardControlHost,
  viewport?: { cols: number; rows: number },
): string | null {
  // Overlays must be sized to the same viewport the dashboard renders at (the tmux
  // pane), not process.stdout (the controlling tty, which reports 80 in tmux). The
  // caller passes the viewport it already computed for this frame; fall back only
  // when invoked outside the render path.
  const { cols, rows } = viewport ?? host.getViewportSize();
  if (host.dashboardOverlayState.kind === "worktree-remove-confirm") {
    return buildWorktreeRemoveConfirmOverlayOutput(host, cols, rows);
  }
  if (host.dashboardErrorState) {
    return buildDashboardErrorOverlayOutput(host, cols, rows);
  }
  if (host.dashboardBusyState) {
    return buildDashboardBusyOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "switcher") {
    return buildSwitcherOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "teammate-picker") {
    return buildTeammatePickerOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "thread-reply") {
    return buildThreadReplyOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "orchestration-input") {
    return buildOrchestrationInputOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "migrate-picker") {
    return buildMigratePickerOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "worktree-list") {
    return buildWorktreeListOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "label-input") {
    return buildLabelInputOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "worktree-input") {
    return buildWorktreeInputOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "service-input") {
    return buildServiceInputOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "tool-picker") {
    return buildToolPickerOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "tool-options") {
    return buildToolOptionsOverlayOutput(host, cols, rows);
  }
  if (host.dashboardOverlayState.kind === "orchestration-route-picker") {
    return buildOrchestrationRoutePickerOverlayOutput(host, cols, rows);
  }
  // Lowest precedence: a stale/disconnected guard claims the screen only when no real overlay
  // is active, so transient dialogs keep working and the guard owns the bare dashboard.
  return buildDashboardRuntimeGuardOverlayOutput(host, cols, rows);
}

export function handleDashboardSubscreenNavigationKey(
  host: DashboardControlHost,
  key: string,
  currentScreen: Exclude<DashboardScreen, "dashboard">,
): boolean {
  if (key === "d") {
    setDashboardScreen(host, "dashboard");
    syncTuiNotificationContext(host, false);
    host.renderDashboard();
    return true;
  }
  // For each screen hotkey: when already on that screen, decline (return false) so the
  // key falls through to the screen's own action handler (e.g. coordination's [c] clear/
  // complete). Otherwise switch to it.
  if (key === "c") {
    if (currentScreen === "coordination") return false;
    host.showCoordination();
    return true;
  }
  if (key === "p") {
    if (currentScreen === "project") return false;
    host.showProject();
    return true;
  }
  if (key === "l") {
    if (currentScreen === "library") return false;
    host.showLibrary();
    return true;
  }
  if (key === "t") {
    if (currentScreen === "topology") return false;
    host.showTopology();
    return true;
  }
  if (key === "g") {
    if (currentScreen === "graveyard") return false;
    host.showGraveyard();
    return true;
  }
  return false;
}

export function openLiveTmuxWindowForEntry(
  host: DashboardControlHost,
  entry: { id: string; backendSessionId?: string; tmuxWindowId?: string },
): "opened" | "missing" | "error" {
  try {
    const target = openManagedSessionWindow(host.tmuxRuntimeManager, dashboardProjectRoot(host), entry);
    if (!target) return "missing";
    primeLiveTmuxFooter(host, target);
    void mutateDashboardApi(host, PROJECT_API_ROUTES.statuslineRefresh, { sessionId: entry.id }).catch(() => {});
    noteTuiNotificationContext(host, { screen: "agent", sessionId: entry.id, panelOpen: false });
    markTuiSessionSeen(host, entry.id);
    noteLastUsedItem(host, entry.id);
    return "opened";
  } catch (error) {
    host.showDashboardError("Failed to open agent", [
      error instanceof Error ? error.message : String(error),
      "The tmux window may still be starting. Try again in a moment.",
    ]);
    return "error";
  }
}

function noteTuiNotificationContext(
  host: DashboardControlHost,
  patch: { screen?: string; sessionId?: string; panelOpen?: boolean },
): void {
  queueTuiNotificationContext(host, patch);
}

function markTuiSessionSeen(host: DashboardControlHost, sessionId: string): void {
  queueTuiSessionSeen(host, sessionId);
}

export async function waitAndOpenLiveTmuxWindowForEntry(
  host: DashboardControlHost,
  entry: { id: string; backendSessionId?: string; tmuxWindowId?: string; status?: string },
  timeoutMs?: number,
): Promise<"opened" | "missing" | "error"> {
  const activationToken = host.dashboardActivationToken;
  const effectiveTimeoutMs = timeoutMs ?? (entry.status === "offline" || entry.status === "exited" ? 60_000 : 3000);
  const deadline = Date.now() + effectiveTimeoutMs;
  while (Date.now() < deadline) {
    if (!dashboardActivationStillCurrent(host, activationToken)) return "missing";
    const remainingMs = Math.max(100, deadline - Date.now());
    const result =
      host.mode === "dashboard"
        ? await openProjectServiceNotificationTarget(host, entry.id, "agent", remainingMs, activationToken)
        : openLiveTmuxWindowForEntry(host, entry);
    if (result !== "missing") return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "missing";
}

export function openLiveTmuxWindowForService(
  host: DashboardControlHost,
  serviceId: string,
): "opened" | "missing" | "error" {
  try {
    const target = openManagedServiceWindow(host.tmuxRuntimeManager, dashboardProjectRoot(host), serviceId);
    if (!target) return "missing";
    primeLiveTmuxFooter(host, target);
    void mutateDashboardApi(host, PROJECT_API_ROUTES.statuslineRefresh, { sessionId: serviceId }).catch(() => {});
    noteLastUsedItem(host, serviceId);
    return "opened";
  } catch (error) {
    host.showDashboardError("Failed to open service", [
      error instanceof Error ? error.message : String(error),
      "The tmux window may still be starting. Try again in a moment.",
    ]);
    return "error";
  }
}

export async function waitAndOpenLiveTmuxWindowForService(
  host: DashboardControlHost,
  serviceId: string,
  timeoutMs = 3000,
): Promise<"opened" | "missing" | "error"> {
  const activationToken = host.dashboardActivationToken;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!dashboardActivationStillCurrent(host, activationToken)) return "missing";
    const remainingMs = Math.max(100, deadline - Date.now());
    const result =
      host.mode === "dashboard"
        ? await openProjectServiceNotificationTarget(host, serviceId, "service", remainingMs, activationToken)
        : openLiveTmuxWindowForService(host, serviceId);
    if (result !== "missing") return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "missing";
}

function dashboardActivationStillCurrent(host: DashboardControlHost, token: any | undefined): boolean {
  if (!token) return true;
  return host.dashboardActivationToken === token && (host.dashboardInputEpoch ?? 0) === token.inputEpoch;
}

async function openProjectServiceNotificationTarget(
  host: DashboardControlHost,
  sessionId: string,
  kind: "agent" | "service",
  timeoutMs: number,
  activationToken: any | undefined,
): Promise<"opened" | "missing" | "error"> {
  try {
    const context = dashboardControlClientContext(host);
    const startedAt = Date.now();
    await mutateDashboardApi(
      host,
      PROJECT_API_ROUTES.controls.openNotificationTarget,
      { sessionId, focus: false },
      {
        timeoutMs,
      },
    );
    if (!dashboardActivationStillCurrent(host, activationToken)) return "missing";
    const focusTimeoutMs = Math.max(100, timeoutMs - (Date.now() - startedAt));
    await mutateDashboardApi(
      host,
      PROJECT_API_ROUTES.controls.openNotificationTarget,
      { sessionId, focus: true, ...context },
      { timeoutMs: focusTimeoutMs },
    );
    return "opened";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found") || message.includes("no longer available") || message.includes("is offline")) {
      return "missing";
    }
    if (!dashboardActivationStillCurrent(host, activationToken)) return "missing";
    host.showDashboardError(`Failed to open ${kind}`, [
      message,
      "The tmux window may still be starting. Try again in a moment.",
    ]);
    return "error";
  }
}

function dashboardControlClientContext(host: DashboardControlHost): {
  currentClientSession?: string;
  clientTty?: string;
  currentWindowId?: string;
} {
  try {
    return {
      currentClientSession: host.tmuxRuntimeManager.currentClientSession() ?? undefined,
      clientTty: host.tmuxRuntimeManager.displayMessage?.("#{client_tty}") ?? undefined,
      currentWindowId: host.tmuxRuntimeManager.displayMessage?.("#{window_id}") ?? undefined,
    };
  } catch {
    return {};
  }
}

export function noteLastUsedItem(host: DashboardControlHost, itemId: string): void {
  markLastUsed(dashboardProjectRoot(host), {
    itemId,
    clientSession: host.tmuxRuntimeManager.currentClientSession() ?? undefined,
  });
  host.invalidateDesktopStateSnapshot();
}

export function getSelectedDashboardWorktreeEntry(host: DashboardControlHost): DashboardWorktreeEntry | undefined {
  if (host.dashboardState.level === "sessions" && host.dashboardState.worktreeEntries.length > 0) {
    return host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex];
  }
  return undefined;
}

export function getSelectedDashboardSessionForActions(host: DashboardControlHost): DashboardSession | undefined {
  const selectedEntry = getSelectedDashboardWorktreeEntry(host);
  if (selectedEntry?.kind === "session") {
    return host.dashboardState.worktreeSessions.find((session: DashboardSession) => session.id === selectedEntry.id);
  }
  if (host.dashboardState.worktreeNavOrder.length <= 1) {
    return host.getDashboardSessions()[host.activeIndex];
  }
  return undefined;
}

export function getSelectedDashboardServiceForActions(host: DashboardControlHost): DashboardService | undefined {
  const selectedEntry = getSelectedDashboardWorktreeEntry(host);
  if (selectedEntry?.kind !== "service") return undefined;
  return host.getDashboardServices().find((service: DashboardService) => service.id === selectedEntry.id);
}

function applyOrchestrationRouteOptions(
  host: DashboardControlHost,
  mode: "message" | "handoff" | "task",
  options: DashboardOrchestrationTarget[],
): void {
  if (options.length === 0) {
    host.showDashboardError("No orchestration targets available", [
      "Select a local agent, define team roles, or enable tools before sending orchestration actions.",
    ]);
    return;
  }

  host.orchestrationRouteMode = mode;
  host.orchestrationRouteOptions = options;
  host.openDashboardOverlay("orchestration-route-picker");
  host.renderOrchestrationRoutePicker();
}

function validOrchestrationRouteOption(value: unknown): value is DashboardOrchestrationTarget {
  if (!value || typeof value !== "object") return false;
  const option = value as DashboardOrchestrationTarget;
  return typeof option.label === "string" && (!option.recipientIds || Array.isArray(option.recipientIds));
}

async function showOrchestrationRoutePickerFromService(
  host: DashboardControlHost,
  mode: "message" | "handoff" | "task",
  lifecycle: DashboardLifecycleToken,
  selectedSessionId?: string,
  worktreePath?: string,
): Promise<void> {
  const params = new URLSearchParams();
  params.set("mode", mode);
  if (selectedSessionId) params.set("selectedSessionId", selectedSessionId);
  if (worktreePath) params.set("worktreePath", worktreePath);
  try {
    const res = await getJsonWithTuiApiRuntime(
      host,
      `${PROJECT_API_ROUTES.orchestration.routes}?${params.toString()}`,
      undefined,
      (requestHost, path, opts) => getFromProjectService(requestHost, path, opts),
    );
    if (!res?.ok || !Array.isArray(res.options) || !res.options.every(validOrchestrationRouteOption)) {
      throw new Error("invalid orchestration route options payload");
    }
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    applyOrchestrationRouteOptions(host, mode, res.options);
  } catch (error) {
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    host.showDashboardError("Failed to load orchestration targets", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

export function showOrchestrationRoutePicker(host: DashboardControlHost, mode: "message" | "handoff" | "task"): void {
  if (host.mode !== "dashboard" || typeof host.getFromProjectService !== "function") {
    host.showDashboardError("Failed to load orchestration targets", [
      "Orchestration routing requires the project service.",
    ]);
    return;
  }
  const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
  const selected = getSelectedDashboardSessionForActions(host);
  const focusedWorktreePath = host.dashboardState.focusedWorktreePath;
  void showOrchestrationRoutePickerFromService(host, mode, lifecycle, selected?.id, focusedWorktreePath);
}

export function showOrchestrationInput(
  host: DashboardControlHost,
  mode: "message" | "handoff" | "task",
  target: DashboardOrchestrationTarget,
): void {
  host.orchestrationInputMode = mode;
  host.orchestrationInputTarget = target;
  host.orchestrationInputBuffer = "";
  host.openDashboardOverlay("orchestration-input");
  host.renderOrchestrationInput();
}

export function buildOrchestrationInputOverlayOutput(
  host: DashboardControlHost,
  cols: number,
  rows: number,
): string | null {
  const target = host.orchestrationInputTarget;
  const mode = host.orchestrationInputMode;
  if (!target || !mode) return null;
  const modeLabel = mode === "message" ? "Send message" : mode === "handoff" ? "Handoff" : "Assign task";
  const actionLabel = mode === "task" ? "assign" : "send";
  const worktreeLine = target.worktreePath ? `  ${style("Worktree:", "muted")} ${target.worktreePath}` : null;
  const recipientCount = target.sessionId ? 1 : (target.recipientIds?.length ?? 0);
  const recipientPreview =
    target.sessionId || recipientCount === 0
      ? null
      : mode === "task"
        ? `  ${style("Route:", "muted")} best match from ${recipientCount} live ${recipientCount === 1 ? "agent" : "agents"}`
        : `  ${style("Recipients:", "muted")} ${recipientCount} live ${recipientCount === 1 ? "agent" : "agents"}${target.recipientIds && target.recipientIds.length > 0 ? ` (${target.recipientIds.slice(0, 3).join(", ")}${target.recipientIds.length > 3 ? ", ..." : ""})` : ""}`;
  const body = [
    `  ${style("To:", "muted")} ${target.label}`,
    ...(worktreeLine ? [worktreeLine] : []),
    ...(recipientPreview ? [recipientPreview] : []),
    `  ${style("Text:", "muted")} ${host.orchestrationInputBuffer}_`,
    "",
    hints([
      ["Enter", actionLabel],
      ["Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox({ title: modeLabel, body, cols, rows });
}

export function renderOrchestrationInput(host: DashboardControlHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const { cols, rows } = host.getViewportSize();
  const output = buildOrchestrationInputOverlayOutput(host, cols, rows);
  if (output) process.stdout.write(output);
}

export function buildOrchestrationRoutePickerOverlayOutput(
  host: DashboardControlHost,
  cols: number,
  rows: number,
): string | null {
  const mode = host.orchestrationRouteMode;
  if (!mode) return null;
  const modeLabel = mode === "message" ? "Send message" : mode === "handoff" ? "Send handoff" : "Assign task";
  const body: string[] = [];
  for (let i = 0; i < Math.min(host.orchestrationRouteOptions.length, 9); i++) {
    body.push(`  ${keycap(String(i + 1))} ${host.orchestrationRouteOptions[i]!.label}`);
  }
  if (host.orchestrationRouteOptions.length > 9) {
    body.push(`  ${style("...", "muted")}`);
  }
  body.push("");
  body.push(hints([["Esc", "cancel"]]));
  return renderOverlayBox({ title: `${modeLabel}: choose target`, body, cols, rows });
}

export function renderOrchestrationRoutePicker(host: DashboardControlHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const { cols, rows } = host.getViewportSize();
  const output = buildOrchestrationRoutePickerOverlayOutput(host, cols, rows);
  if (output) process.stdout.write(output);
}

// Shared retry/recovery loop for project-service requests. Route calls are the liveness
// probe; only dead endpoints trigger control-plane recovery, and timeouts stay visible.
async function requestProjectService(
  host: DashboardControlHost,
  path: string,
  opts: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<any> {
  const projectRoot = dashboardProjectRoot(host);
  const timeoutMs = opts.timeoutMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (let attempt = 0; Date.now() <= deadline; attempt += 1) {
    const endpoint = loadMetadataEndpoint(projectRoot);
    if (!endpoint) {
      await ensureDashboardControlPlane(host, remainingProjectServiceDeadline(deadline));
      await sleepProjectServiceRetry(attempt, deadline);
      continue;
    }
    const endpointState = await endpointStateForRequest(
      host,
      endpoint,
      Math.min(1000, remainingProjectServiceDeadline(deadline)),
    );
    if (endpointState === "stale" && Date.now() < deadline) {
      clearProjectServiceEndpointHealth(host);
      removeMetadataEndpoint(projectRoot);
      await ensureDashboardControlPlane(host, remainingProjectServiceDeadline(deadline), {
        restartProjectService: true,
      });
      await sleepProjectServiceRetry(attempt, deadline);
      continue;
    }
    if (endpointState === "stale") {
      throw new Error("project service endpoint is stale");
    }
    if (endpointState === "unknown") {
      lastError = new Error("project service endpoint could not be verified");
      if (Date.now() < deadline) {
        await sleepProjectServiceRetry(attempt, deadline);
        continue;
      }
      throw lastError;
    }
    try {
      const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
        method: opts.method,
        headers: opts.method === "POST" ? { "content-type": "application/json" } : undefined,
        body: opts.method === "POST" ? opts.body : undefined,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      if (status >= 200 && status < 300 && json?.ok !== false) {
        return json;
      }
      lastError = new DashboardProjectServiceHttpError(status, json, json?.error || `request failed: ${status}`);
      if (isProjectServiceRetryableStatus(status) && Date.now() < deadline) {
        clearProjectServiceEndpointHealth(host);
        await ensureDashboardControlPlane(host, remainingProjectServiceDeadline(deadline), {
          restartProjectService: true,
        });
        await sleepProjectServiceRetry(attempt, deadline);
        continue;
      }
      throw lastError;
    } catch (error) {
      lastError = error;
      if (isHttpTimeoutError(error) && opts.method === "GET" && Date.now() < deadline) {
        await sleepProjectServiceRetry(attempt, deadline);
        continue;
      }
      if (isProjectServiceConnectionError(error) && Date.now() < deadline) {
        clearProjectServiceEndpointHealth(host);
        removeMetadataEndpoint(projectRoot);
        await ensureDashboardControlPlane(host, remainingProjectServiceDeadline(deadline), {
          restartProjectService: true,
        });
        await sleepProjectServiceRetry(attempt, deadline);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no live project service endpoint");
}

export async function resolveCurrentProjectServiceEndpointForDashboard(
  host: DashboardControlHost,
  timeoutMs = 1000,
): Promise<{ host: string; port: number; pid?: number } | null> {
  const projectRoot = dashboardProjectRoot(host);
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; Date.now() <= deadline; attempt += 1) {
    let endpoint = loadMetadataEndpoint(projectRoot);
    if (!endpoint) {
      await ensureDashboardControlPlane(host, remainingProjectServiceDeadline(deadline));
      endpoint = loadMetadataEndpoint(projectRoot);
    }
    if (!endpoint) {
      await sleepProjectServiceRetry(attempt, deadline);
      continue;
    }
    const endpointState = await endpointStateForRequest(
      host,
      endpoint,
      remainingProjectServiceDeadline(deadline),
      projectRoot,
    );
    if (endpointState === "current") return endpoint;
    if (endpointState === "stale" && Date.now() < deadline) {
      clearProjectServiceEndpointHealth(host);
      removeMetadataEndpoint(projectRoot);
      await ensureDashboardControlPlane(host, remainingProjectServiceDeadline(deadline), {
        restartProjectService: true,
      });
    }
    await sleepProjectServiceRetry(attempt, deadline);
  }
  return null;
}

async function endpointStateForRequest(
  host: DashboardControlHost,
  endpoint: { host: string; port: number; pid?: number },
  timeoutMs: number,
  projectRoot = dashboardProjectRoot(host),
): Promise<ProjectServiceEndpointState> {
  const key = projectServiceEndpointHealthKey(endpoint, projectRoot);
  const cached = host.dashboardProjectServiceEndpointHealth as { key?: string; checkedAt?: number } | undefined;
  if (cached?.key === key && typeof cached.checkedAt === "number") {
    if (Date.now() - cached.checkedAt <= PROJECT_SERVICE_ENDPOINT_HEALTH_CACHE_MS) return "current";
  }
  const current = await endpointMatchesCurrentProjectService(endpoint, timeoutMs, projectRoot);
  if (current === "current") markProjectServiceEndpointCurrent(host, endpoint, projectRoot);
  else clearProjectServiceEndpointHealth(host);
  return current;
}

function projectServiceEndpointHealthKey(
  endpoint: { host: string; port: number; pid?: number },
  projectRoot: string,
): string {
  return `${endpoint.host}:${endpoint.port}:${endpoint.pid ?? "unknown"}:${getProjectStateDirFor(projectRoot)}`;
}

function markProjectServiceEndpointCurrent(
  host: DashboardControlHost,
  endpoint: { host: string; port: number; pid?: number },
  projectRoot: string,
): void {
  host.dashboardProjectServiceEndpointHealth = {
    key: projectServiceEndpointHealthKey(endpoint, projectRoot),
    checkedAt: Date.now(),
  };
}

function clearProjectServiceEndpointHealth(host: DashboardControlHost): void {
  host.dashboardProjectServiceEndpointHealth = undefined;
}

async function endpointMatchesCurrentProjectService(
  endpoint: { host: string; port: number; pid?: number },
  timeoutMs: number,
  projectRoot: string,
): Promise<ProjectServiceEndpointState> {
  try {
    const { status, json } = await requestJson<{
      pid?: number;
      projectStateDir?: string;
      serviceInfo?: ProjectServiceManifest;
    }>(`http://${endpoint.host}:${endpoint.port}${PROJECT_API_ROUTES.health}`, { timeoutMs: Math.max(1, timeoutMs) });
    if (status < 200 || status >= 300) return "unknown";
    return json?.pid === endpoint.pid &&
      json?.projectStateDir === getProjectStateDirFor(projectRoot) &&
      manifestsMatch(getProjectServiceManifest(), json?.serviceInfo)
      ? "current"
      : "stale";
  } catch (error) {
    if (isHttpTimeoutError(error)) return "unknown";
    return isProjectServiceConnectionError(error) ? "stale" : "unknown";
  }
}

export async function postToProjectService(
  host: DashboardControlHost,
  path: string,
  body: unknown,
  opts?: { timeoutMs?: number },
): Promise<any> {
  return requestProjectService(host, path, { method: "POST", body, timeoutMs: opts?.timeoutMs });
}

export async function getFromProjectService(
  host: DashboardControlHost,
  path: string,
  opts?: { timeoutMs?: number },
): Promise<any> {
  return requestProjectService(host, path, { method: "GET", timeoutMs: opts?.timeoutMs });
}

function isProjectServiceConnectionError(error: unknown): boolean {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("socket hang up")
  );
}

function isProjectServiceRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function remainingProjectServiceDeadline(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function sleepProjectServiceRetry(attempt: number, deadline: number): Promise<void> {
  const delayMs = Math.min(250, 50 + attempt * 25, Math.max(0, deadline - Date.now()));
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withProjectServiceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`project service recovery timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function ensureDashboardControlPlane(
  host: DashboardControlHost,
  timeoutMs = 10_000,
  opts: { restartProjectService?: boolean } = {},
): Promise<void> {
  if (host.dashboardServiceRecovery) {
    await withProjectServiceTimeout(host.dashboardServiceRecovery, timeoutMs);
    if (!opts.restartProjectService) {
      return;
    }
    if (host.dashboardServiceRecovery) {
      await withProjectServiceTimeout(host.dashboardServiceRecovery, timeoutMs);
    }
    if (!host.dashboardServiceRecovery) {
      return ensureDashboardControlPlane(host, timeoutMs, opts);
    }
    return;
  }
  const recovery = (async () => {
    const projectRoot = dashboardProjectRoot(host);
    await ensureDaemonRunning();
    if (opts.restartProjectService) {
      await stopProjectService(projectRoot);
      removeMetadataEndpoint(projectRoot);
    }
    await ensureProjectService(projectRoot);
  })();
  host.dashboardServiceRecovery = recovery;
  try {
    await withProjectServiceTimeout(recovery, timeoutMs);
  } finally {
    if (host.dashboardServiceRecovery === recovery) {
      host.dashboardServiceRecovery = null;
    }
  }
}

export function handleOrchestrationInputKey(host: DashboardControlHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = commandKey(event);

  if (key === "escape") {
    host.clearDashboardOverlay();
    host.orchestrationInputBuffer = "";
    host.orchestrationInputMode = null;
    host.orchestrationInputTarget = null;
    host.renderDashboard();
    return;
  }

  if (key === "enter" || key === "return") {
    const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
    const mode = host.orchestrationInputMode;
    const target = host.orchestrationInputTarget;
    const body = host.orchestrationInputBuffer.trim();
    host.clearDashboardOverlay();
    host.orchestrationInputBuffer = "";
    host.orchestrationInputMode = null;
    host.orchestrationInputTarget = null;
    if (!mode || !target || !body) {
      host.renderDashboard();
      return;
    }
    void host.submitDashboardOrchestrationAction(mode, target, body, lifecycle);
    return;
  }

  if (key === "backspace" || key === "delete") {
    host.orchestrationInputBuffer = host.orchestrationInputBuffer.slice(0, -1);
    host.renderOrchestrationInput();
    return;
  }

  if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
    host.orchestrationInputBuffer += event.char;
    host.renderOrchestrationInput();
  }
}

export function handleOrchestrationRoutePickerKey(host: DashboardControlHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = commandKey(event);

  if (key === "escape") {
    host.clearDashboardOverlay();
    host.orchestrationRouteMode = null;
    host.orchestrationRouteOptions = [];
    host.renderDashboard();
    return;
  }

  if (key && /^[1-9]$/.test(key)) {
    const idx = parseInt(key, 10) - 1;
    const target = host.orchestrationRouteOptions[idx];
    const mode = host.orchestrationRouteMode;
    host.clearDashboardOverlay();
    host.orchestrationRouteMode = null;
    host.orchestrationRouteOptions = [];
    if (!target || !mode) {
      host.renderDashboard();
      return;
    }
    showOrchestrationInput(host, mode, target);
  }
}
