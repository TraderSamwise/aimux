import { loadConfig } from "../config.js";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardService, DashboardSession, DashboardWorktreeEntry } from "../dashboard/index.js";
import type { DashboardScreen } from "../dashboard/state.js";
import { updateNotificationContext } from "../notification-context.js";
import { requestJson } from "../http-client.js";
import { markLastUsed } from "../last-used.js";
import { loadMetadataState, resolveProjectServiceEndpoint } from "../metadata-store.js";
import { parseKeys } from "../key-parser.js";
import { ensureDaemonRunning, ensureProjectService } from "../daemon.js";
import { getProjectStateDir } from "../paths.js";
import { loadTeamConfig } from "../team.js";
import { loadStatusline, renderTmuxStatuslineFromData } from "../tmux/statusline.js";
import { openManagedServiceWindow, openManagedSessionWindow } from "../tmux/window-open.js";
import { resolveOrchestrationRecipients } from "../orchestration-routing.js";
import { sortDashboardEntriesByCreatedAt } from "../dashboard/sort.js";
import {
  buildDashboardBusyOverlayOutput,
  buildDashboardErrorOverlayOutput,
  buildLabelInputOverlayOutput,
  buildMigratePickerOverlayOutput,
  buildNotificationPanelOverlayOutput,
  buildServiceInputOverlayOutput,
  buildSwitcherOverlayOutput,
  buildWorktreeListOverlayOutput,
  buildWorktreeRemoveConfirmOverlayOutput,
} from "../tui/screens/overlay-renderers.js";
import { buildWorktreeInputOverlayOutput } from "./worktrees.js";
import { buildToolOptionsOverlayOutput, buildToolPickerOverlayOutput } from "./tool-picker.js";
import { buildThreadReplyOverlayOutput } from "./subscreens.js";

type DashboardControlHost = any;
type DashboardOrchestrationTarget = {
  label: string;
  sessionId?: string;
  assignee?: string;
  tool?: string;
  worktreePath?: string;
  recipientIds?: string[];
};

function writeStatuslineTextFile(name: string, content: string): void {
  const dir = join(getProjectStateDir(), "tmux-statusline");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${content}\n`);
  renameSync(tmpPath, filePath);
}

function primeLiveTmuxFooter(host: DashboardControlHost, target: { windowId: string; windowName: string }): void {
  try {
    const data = loadStatusline(process.cwd());
    if (!data) return;
    const currentPath =
      host.tmuxRuntimeManager.displayMessage("#{pane_current_path}", target.windowId) ?? process.cwd();
    const top = renderTmuxStatuslineFromData(data, process.cwd(), "top", {
      currentWindow: target.windowName,
      currentWindowId: target.windowId,
      currentPath,
    });
    const bottom = renderTmuxStatuslineFromData(data, process.cwd(), "bottom", {
      currentWindow: target.windowName,
      currentWindowId: target.windowId,
      currentPath,
    });
    writeStatuslineTextFile(`top-${target.windowId}.txt`, top);
    writeStatuslineTextFile(`bottom-${target.windowId}.txt`, bottom);
  } catch {}
}

export function updateWorktreeSessions(host: DashboardControlHost): void {
  const allDash = host.getDashboardSessions();
  host.dashboardState.worktreeSessions = sortDashboardEntriesByCreatedAt(
    allDash.filter((s: DashboardSession) => {
      return (s.worktreePath ?? undefined) === host.dashboardState.focusedWorktreePath;
    }),
  );
  const filteredServices: DashboardService[] = host.getDashboardServices().filter((service: DashboardService) => {
    return (service.worktreePath ?? undefined) === host.dashboardState.focusedWorktreePath;
  });
  const worktreeServices = sortDashboardEntriesByCreatedAt(filteredServices);
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
  updateNotificationContext("tui", {
    focused: true,
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

export function handleActiveDashboardOverlayKey(host: DashboardControlHost, data: Buffer): boolean {
  if (host.dashboardBusyState) {
    return true;
  }
  if (host.dashboardErrorState) {
    const events = parseKeys(data);
    if (events.length === 0) return true;
    const key = events[0].name || events[0].char;
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
    case "notification-panel":
      host.handleNotificationPanelKey(data);
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

export function buildActiveDashboardOverlayOutput(host: DashboardControlHost): string | null {
  if (host.dashboardOverlayState.kind === "worktree-remove-confirm") {
    return buildWorktreeRemoveConfirmOverlayOutput(host);
  }
  if (host.dashboardErrorState) {
    return buildDashboardErrorOverlayOutput(host);
  }
  if (host.dashboardBusyState) {
    return buildDashboardBusyOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "switcher") {
    return buildSwitcherOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "notification-panel") {
    return buildNotificationPanelOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "thread-reply") {
    return buildThreadReplyOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "orchestration-input") {
    return buildOrchestrationInputOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "migrate-picker") {
    return buildMigratePickerOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "worktree-list") {
    return buildWorktreeListOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "label-input") {
    return buildLabelInputOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "worktree-input") {
    return buildWorktreeInputOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "service-input") {
    return buildServiceInputOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "tool-picker") {
    return buildToolPickerOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "tool-options") {
    return buildToolOptionsOverlayOutput(host);
  }
  if (host.dashboardOverlayState.kind === "orchestration-route-picker") {
    return buildOrchestrationRoutePickerOverlayOutput(host);
  }
  return null;
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
  if (key === "a") {
    if (currentScreen === "activity") {
      host.renderActivityDashboard();
    } else {
      host.showActivityDashboard();
    }
    return true;
  }
  if (key === "t") {
    if (currentScreen === "threads") {
      host.renderThreads();
    } else {
      host.showThreads();
    }
    return true;
  }
  if (key === "i") {
    if (currentScreen === "notifications") {
      host.renderNotifications();
    } else {
      host.showNotifications();
    }
    return true;
  }
  if (key === "y") {
    if (currentScreen === "workflow") {
      host.renderWorkflow();
    } else {
      host.showWorkflow();
    }
    return true;
  }
  if (key === "p") {
    if (currentScreen === "plans") {
      host.renderPlans();
    } else {
      host.showPlans();
    }
    return true;
  }
  if (key === "g") {
    if (currentScreen === "graveyard") {
      host.renderGraveyard();
    } else {
      host.showGraveyard();
    }
    return true;
  }
  return false;
}

export function openLiveTmuxWindowForEntry(
  host: DashboardControlHost,
  entry: { id: string; backendSessionId?: string },
): "opened" | "missing" | "error" {
  try {
    const target = openManagedSessionWindow(host.tmuxRuntimeManager, process.cwd(), entry);
    if (!target) return "missing";
    primeLiveTmuxFooter(host, target);
    void host.postToProjectService("/statusline/refresh", { sessionId: entry.id }).catch(() => {});
    host.agentTracker.markSeen(entry.id);
    updateNotificationContext("tui", {
      focused: true,
      sessionId: entry.id,
      panelOpen: false,
    });
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

export async function waitAndOpenLiveTmuxWindowForEntry(
  host: DashboardControlHost,
  entry: { id: string; backendSessionId?: string },
  timeoutMs = 3000,
): Promise<"opened" | "missing" | "error"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = openLiveTmuxWindowForEntry(host, entry);
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
    const target = openManagedServiceWindow(host.tmuxRuntimeManager, process.cwd(), serviceId);
    if (!target) return "missing";
    primeLiveTmuxFooter(host, target);
    void host.postToProjectService("/statusline/refresh", { sessionId: serviceId }).catch(() => {});
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = openLiveTmuxWindowForService(host, serviceId);
    if (result !== "missing") return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "missing";
}

export function noteLastUsedItem(host: DashboardControlHost, itemId: string): void {
  markLastUsed(process.cwd(), {
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

export function showOrchestrationRoutePicker(host: DashboardControlHost, mode: "message" | "handoff" | "task"): void {
  const selected = getSelectedDashboardSessionForActions(host);
  const options: DashboardOrchestrationTarget[] = [];
  const focusedWorktreePath = host.mode === "dashboard" ? host.dashboardState.focusedWorktreePath : undefined;
  const metadataState = loadMetadataState().sessions;
  const candidates = host.sessions.map((session: any) => {
    const derivedActivity = metadataState[session.id]?.derived?.activity;
    const semanticStatus =
      derivedActivity === "running" ? "running" : derivedActivity === "waiting" ? "waiting" : session.status;
    const semantic = host.deriveSessionSemanticState(session.id, semanticStatus);
    return {
      id: session.id,
      tool: host.sessionToolKeys.get(session.id) ?? session.command,
      role: host.sessionRoles.get(session.id),
      worktreePath: host.sessionWorktreePaths.get(session.id),
      status: semantic.user.label,
      canReceiveInput: semantic.runtime.canReceiveInput,
      isAlive: semantic.runtime.isAlive,
      workflowPressure: host.orchestrationWorkflowPressure(session.id, semanticStatus),
      exited: session.exited,
    };
  });

  if (selected && !selected.remoteInstancePid) {
    options.push({
      label: `${selected.label ?? selected.command ?? selected.id} (${selected.id})`,
      sessionId: selected.id,
    });
  }

  const team = loadTeamConfig();
  for (const [role, cfg] of Object.entries(team.roles as Record<string, { description?: string }>)) {
    const recipientIds = resolveOrchestrationRecipients({
      candidates,
      assignee: role,
      worktreePath: focusedWorktreePath,
    });
    if (recipientIds.length === 0) continue;
    options.push({
      label: `Role: ${role}${cfg.description ? ` — ${cfg.description}` : ""}${host.formatRoutePreview(recipientIds)}`,
      assignee: role,
      worktreePath: focusedWorktreePath,
      recipientIds,
    });
  }

  const config = loadConfig();
  for (const [toolKey, toolCfg] of Object.entries(config.tools)) {
    if (!toolCfg.enabled) continue;
    const recipientIds = resolveOrchestrationRecipients({
      candidates,
      tool: toolKey,
      worktreePath: focusedWorktreePath,
    });
    if (recipientIds.length === 0) continue;
    options.push({
      label: `Tool: ${toolKey}${host.formatRoutePreview(recipientIds)}`,
      tool: toolKey,
      worktreePath: focusedWorktreePath,
      recipientIds,
    });
  }

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

export function buildOrchestrationInputOverlayOutput(host: DashboardControlHost): string | null {
  const target = host.orchestrationInputTarget;
  const mode = host.orchestrationInputMode;
  if (!target || !mode) return null;
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const modeLabel = mode === "message" ? "Send message" : mode === "handoff" ? "Handoff" : "Assign task";
  const actionLabel = mode === "task" ? "assign" : "send";
  const worktreeLine = target.worktreePath ? `  Worktree: ${target.worktreePath}` : null;
  const recipientCount = target.sessionId ? 1 : (target.recipientIds?.length ?? 0);
  const recipientPreview =
    target.sessionId || recipientCount === 0
      ? null
      : mode === "task"
        ? `  Route: best match from ${recipientCount} live ${recipientCount === 1 ? "agent" : "agents"}`
        : `  Recipients: ${recipientCount} live ${recipientCount === 1 ? "agent" : "agents"}${target.recipientIds && target.recipientIds.length > 0 ? ` (${target.recipientIds.slice(0, 3).join(", ")}${target.recipientIds.length > 3 ? ", ..." : ""})` : ""}`;
  const lines = [
    `${modeLabel}:`,
    "",
    `  To: ${target.label}`,
    ...(worktreeLine ? [worktreeLine] : []),
    ...(recipientPreview ? [recipientPreview] : []),
    `  Text: ${host.orchestrationInputBuffer}_`,
    "",
    `  [Enter] ${actionLabel}  [Esc] cancel`,
  ];

  const boxWidth = Math.max(...lines.map((l) => l.length)) + 4;
  const startRow = Math.floor((rows - lines.length - 2) / 2);
  const startCol = Math.floor((cols - boxWidth) / 2);
  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
    } else {
      const line = lines[i - 1]!;
      output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
}

export function renderOrchestrationInput(host: DashboardControlHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const output = buildOrchestrationInputOverlayOutput(host);
  if (output) process.stdout.write(output);
}

export function buildOrchestrationRoutePickerOverlayOutput(host: DashboardControlHost): string | null {
  const mode = host.orchestrationRouteMode;
  if (!mode) return null;
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const modeLabel = mode === "message" ? "Send message" : mode === "handoff" ? "Send handoff" : "Assign task";
  const lines = [`${modeLabel}: choose target`, ""];
  for (let i = 0; i < Math.min(host.orchestrationRouteOptions.length, 9); i++) {
    lines.push(`  [${i + 1}] ${host.orchestrationRouteOptions[i]!.label}`);
  }
  if (host.orchestrationRouteOptions.length > 9) {
    lines.push("  ...");
  }
  lines.push("");
  lines.push("  [Esc] cancel");

  const boxWidth = Math.max(...lines.map((l) => l.length)) + 4;
  const startRow = Math.floor((rows - lines.length - 2) / 2);
  const startCol = Math.floor((cols - boxWidth) / 2);
  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
    } else {
      const line = lines[i - 1]!;
      output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
}

export function renderOrchestrationRoutePicker(host: DashboardControlHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const output = buildOrchestrationRoutePickerOverlayOutput(host);
  if (output) process.stdout.write(output);
}

export async function postToProjectService(
  host: DashboardControlHost,
  path: string,
  body: unknown,
  opts?: { timeoutMs?: number },
): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const endpoint = resolveProjectServiceEndpoint(process.cwd());
    if (!endpoint) {
      await ensureDashboardControlPlane(host);
      continue;
    }
    try {
      const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        timeoutMs: opts?.timeoutMs ?? 1000,
      });
      if (status >= 200 && status < 300 && json?.ok !== false) {
        return json;
      }
      if (attempt === 0) {
        await ensureDashboardControlPlane(host);
        continue;
      }
      throw new Error(json?.error || `request failed: ${status}`);
    } catch (error) {
      if (attempt === 0) {
        await ensureDashboardControlPlane(host);
        continue;
      }
      throw error;
    }
  }
  throw new Error("no live project service endpoint");
}

export async function ensureDashboardControlPlane(host: DashboardControlHost): Promise<void> {
  if (host.dashboardServiceRecovery) {
    await host.dashboardServiceRecovery;
    return;
  }
  host.dashboardServiceRecovery = (async () => {
    await ensureDaemonRunning();
    await ensureProjectService(process.cwd());
  })();
  try {
    await host.dashboardServiceRecovery;
  } finally {
    host.dashboardServiceRecovery = null;
  }
}

export function handleOrchestrationInputKey(host: DashboardControlHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;

  if (key === "escape") {
    host.clearDashboardOverlay();
    host.orchestrationInputBuffer = "";
    host.orchestrationInputMode = null;
    host.orchestrationInputTarget = null;
    host.renderDashboard();
    return;
  }

  if (key === "enter" || key === "return") {
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
    void host.submitDashboardOrchestrationAction(mode, target, body);
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
  const key = event.name || event.char;

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
