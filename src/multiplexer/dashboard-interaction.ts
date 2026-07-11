import { execSync } from "node:child_process";
import type { DashboardService, DashboardSession } from "../dashboard/index.js";
import { buildDashboardQuickJumpWorktrees } from "../dashboard/quick-jump.js";
import { selectDashboardTeammates } from "../dashboard/session-registry.js";
import { commandKey, isShiftedLetterCommand, parseKeys, printableInputText, type KeyEvent } from "../key-parser.js";
import { isBlockingPendingDashboardActionKind } from "../pending-actions.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import {
  getDefaultTeamConfig,
  isTeammateSession,
  isOverseerSession,
  loadTeamConfig,
  type TeamConfig,
} from "../team.js";
import {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  renderDashboardIfCurrent,
  type DashboardLifecycleToken,
} from "./dashboard-lifecycle.js";
import { mutateDashboardApi, refreshDashboardModelThroughApi } from "./dashboard-api-client.js";

function hasBlockingPendingDashboardAction(entry: { pendingAction?: string } | null | undefined): boolean {
  return isBlockingPendingDashboardActionKind(entry?.pendingAction);
}

function isStoppableStartingService(
  host: any,
  entry: { id?: string; pendingAction?: string } | null | undefined,
): boolean {
  return Boolean(
    entry &&
    (entry.pendingAction === "creating" ||
      entry.pendingAction === "starting" ||
      (typeof entry.id === "string" && host.dashboardActivatingServiceIds?.has?.(entry.id))),
  );
}

function pendingDashboardItemMessage(
  entry: { pendingAction?: string; label?: string; command?: string; id?: string },
  fallbackKind: "agent" | "service",
): string {
  const action = entry.pendingAction ?? "pending";
  const name = entry.label ?? entry.command ?? entry.id ?? fallbackKind;
  return `${fallbackKind === "agent" ? "Agent" : "Service"} ${name} is ${action}`;
}

function flashPendingDashboardItem(
  host: any,
  entry: { pendingAction?: string; label?: string; command?: string; id?: string },
  fallbackKind: "agent" | "service",
): void {
  host.footerFlash = pendingDashboardItemMessage(entry, fallbackKind);
  host.footerFlashTicks = 3;
  host.renderDashboard();
}

async function refreshDashboardAfterServiceOpen(host: any, activationToken: any): Promise<void> {
  try {
    await refreshDashboardModelThroughApi(host, { force: true });
  } catch {}
  if (isCurrentDashboardActivation(host, activationToken)) {
    host.renderDashboard();
  }
}

function isBlockedOfflineSession(entry: DashboardSession | undefined): boolean {
  return Boolean(
    entry && (entry.status === "offline" || entry.status === "exited") && entry.restoreState === "blocked",
  );
}

function flashBlockedOfflineSession(host: any, entry: DashboardSession): void {
  const label = entry.label ?? entry.command ?? entry.id;
  const reason = entry.restoreBlockedReason ?? "not restorable";
  host.footerFlash = `Cannot restore ${label}: ${reason}`;
  host.footerFlashTicks = 4;
  host.renderDashboard();
}

function findDashboardWorktreeGroup(host: any, worktreePath: string | undefined): any | undefined {
  return host.dashboardWorktreeGroupsCache.find((group: any) => group.path === worktreePath);
}

function isTeamConfig(value: unknown): value is TeamConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as TeamConfig;
  if (!config.roles || typeof config.roles !== "object") return false;
  return Object.values(config.roles).every(
    (role) =>
      role &&
      typeof role === "object" &&
      typeof role.description === "string" &&
      (role.canEdit === undefined || typeof role.canEdit === "boolean") &&
      (role.reviewedBy === undefined || typeof role.reviewedBy === "string"),
  );
}

function loadDashboardTeamConfig(): TeamConfig {
  try {
    const team = loadTeamConfig();
    return isTeamConfig(team) ? team : getDefaultTeamConfig();
  } catch {
    return getDefaultTeamConfig();
  }
}

function isRemovingDashboardWorktree(group: any | undefined): boolean {
  return Boolean(group?.removing || group?.pendingAction === "removing" || group?.pendingAction === "graveyarding");
}

function isCreatingDashboardWorktree(group: any | undefined): boolean {
  return Boolean(group?.pendingAction === "creating");
}

function isFailedDashboardWorktree(group: any | undefined): boolean {
  return Boolean(group?.operationFailure);
}

function beginDashboardActivation(host: any, targetKind: "session" | "service", targetId: string): any | undefined {
  if (host.mode !== "dashboard") return undefined;
  const token = { targetKind, targetId, inputEpoch: host.dashboardInputEpoch ?? 0 };
  host.dashboardActivationToken = token;
  return token;
}

function isCurrentDashboardActivation(host: any, token: any | undefined): boolean {
  if (!token) return true;
  return host.dashboardActivationToken === token && (host.dashboardInputEpoch ?? 0) === token.inputEpoch;
}

function isShiftedCommand(event: KeyEvent, lowerKey: string, letter: string): boolean {
  return isShiftedLetterCommand(event, lowerKey, letter);
}

function isPlainDashboardNavigationEvent(event: KeyEvent, key: string): boolean {
  if (event.shift || event.ctrl || event.alt) return false;
  if (["up", "down", "left", "right", "enter", "escape"].includes(key)) return true;
  if (!["h", "j", "k", "l"].includes(key)) return false;
  return event.name === "" && event.char === key;
}

function shouldContinueCoalescedDashboardInputAfterActivation(host: any, key: string, nextEvent: KeyEvent): boolean {
  if (!(key === "enter" || key === "return" || key === "right" || key === "l")) return false;
  if (commandKey(nextEvent) !== "x") return false;
  const service = host.getSelectedDashboardServiceForActions?.();
  if (!service) return false;
  return isStoppableStartingService(host, service);
}

function stepIntoFocusedDashboardWorktree(host: any): void {
  const focusedGroup = findDashboardWorktreeGroup(host, host.dashboardState.focusedWorktreePath);
  if (isCreatingDashboardWorktree(focusedGroup)) {
    host.footerFlash = creatingWorktreeMessage(focusedGroup, host.dashboardState.focusedWorktreePath);
    host.footerFlashTicks = 3;
    host.renderDashboard();
    return;
  }
  if (isRemovingDashboardWorktree(focusedGroup)) {
    host.footerFlash = blockedRemovingWorktreeMessage(focusedGroup, host.dashboardState.focusedWorktreePath);
    host.footerFlashTicks = 3;
    host.renderDashboard();
    return;
  }
  if (isFailedDashboardWorktree(focusedGroup)) {
    host.footerFlash = failedWorktreeMessage(focusedGroup, host.dashboardState.focusedWorktreePath);
    host.footerFlashTicks = 4;
    host.renderDashboard();
    return;
  }
  host.updateWorktreeSessions();
  if (host.dashboardState.worktreeEntries.length > 0) {
    host.dashboardState.level = "sessions";
    host.dashboardState.sessionIndex = 0;
    host.renderDashboard();
  }
}

function handleDashboardNavigationKey(host: any, key: string, hasWorktrees: boolean): boolean {
  if (!hasWorktrees) {
    const totalCount = host.getDashboardSessions().length;
    switch (key) {
      case "down":
      case "j":
        if (totalCount > 1) {
          host.activeIndex = (host.activeIndex + 1) % totalCount;
          host.renderDashboard();
        }
        return true;
      case "up":
      case "k":
        if (totalCount > 1) {
          host.activeIndex = (host.activeIndex - 1 + totalCount) % totalCount;
          host.renderDashboard();
        }
        return true;
      case "enter":
      case "right":
      case "l": {
        const entry = host.getDashboardSessions()[host.activeIndex];
        if (entry) {
          void host.activateDashboardEntry(entry);
          return true;
        }
        if (host.sessions.length > 0) host.focusSession(host.activeIndex);
        return true;
      }
      case "escape":
        if (host.sessions.length > 0) host.focusSession(host.activeIndex);
        return true;
      case "left":
      case "h":
        return true;
    }
    return false;
  }

  if (host.dashboardState.level === "worktrees") {
    switch (key) {
      case "down":
      case "j": {
        const order = host.dashboardState.worktreeNavOrder;
        if (order.length === 0) return true;
        const curIdx = order.indexOf(host.dashboardState.focusedWorktreePath);
        host.dashboardState.focusedWorktreePath = order[curIdx < 0 ? 0 : (curIdx + 1) % order.length];
        host.renderDashboard();
        return true;
      }
      case "up":
      case "k": {
        const order = host.dashboardState.worktreeNavOrder;
        if (order.length === 0) return true;
        const curIdx = order.indexOf(host.dashboardState.focusedWorktreePath);
        host.dashboardState.focusedWorktreePath = order[curIdx < 0 ? 0 : (curIdx - 1 + order.length) % order.length];
        host.renderDashboard();
        return true;
      }
      case "enter":
      case "right":
      case "l":
        stepIntoFocusedDashboardWorktree(host);
        return true;
      case "escape":
        if (host.sessions.length > 0) host.focusSession(host.activeIndex);
        return true;
      case "left":
      case "h":
        return true;
    }
    return false;
  }

  switch (key) {
    case "down":
    case "j":
      if (host.dashboardState.worktreeEntries.length > 1) {
        host.dashboardState.sessionIndex =
          (host.dashboardState.sessionIndex + 1) % host.dashboardState.worktreeEntries.length;
        host.renderDashboard();
      }
      return true;
    case "up":
    case "k":
      if (host.dashboardState.worktreeEntries.length > 1) {
        host.dashboardState.sessionIndex =
          (host.dashboardState.sessionIndex - 1 + host.dashboardState.worktreeEntries.length) %
          host.dashboardState.worktreeEntries.length;
        host.renderDashboard();
      }
      return true;
    case "enter":
    case "right":
    case "l":
      host.activateSelectedDashboardWorktreeEntry();
      return true;
    case "escape":
    case "left":
    case "h":
      host.dashboardState.level = "worktrees";
      host.renderDashboard();
      return true;
  }
  return false;
}

function failedWorktreeMessage(group: any | undefined, worktreePath: string | undefined): string {
  const name = group?.name ?? worktreePath?.split("/").pop() ?? "worktree";
  return `Worktree ${name} failed: ${group?.operationFailure?.message ?? "operation failed"}`;
}

function blockedRemovingWorktreeMessage(group: any | undefined, worktreePath: string | undefined): string {
  const action = group?.pendingAction === "graveyarding" ? "graveyarding" : "removing";
  return `Worktree ${group?.name ?? worktreePath?.split("/").pop() ?? "worktree"} is ${action}`;
}

function creatingWorktreeMessage(group: any | undefined, worktreePath: string | undefined): string {
  const name = group?.name ?? worktreePath?.split("/").pop() ?? "worktree";
  return `Worktree ${name} is still creating`;
}

export type DashboardActivationResult = "opened" | "missing" | "error" | "blocked" | "pending";

function refreshSelectedWorktreeEntry(host: any): { kind: "session" | "service"; id: string } | undefined {
  const before = host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex];
  host.updateWorktreeSessions?.();
  if (before) {
    const nextIndex = host.dashboardState.worktreeEntries.findIndex(
      (entry: any) => entry.kind === before.kind && entry.id === before.id,
    );
    if (nextIndex >= 0) {
      host.dashboardState.sessionIndex = nextIndex;
    }
  }
  return host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex];
}

function moveSelectedDashboardWorktreeEntry(host: any, direction: "up" | "down"): boolean {
  if (host.dashboardState.level !== "sessions") return false;
  const selectedEntry = host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex];
  if (!selectedEntry) return false;

  const peerEntries = host.dashboardState.worktreeEntries.filter((entry: any) => entry.kind === selectedEntry.kind);
  const moved = host.dashboardUiStateStore.moveEntryWithinWorktree({
    kind: selectedEntry.kind,
    worktreePath: host.dashboardState.focusedWorktreePath,
    selectedId: selectedEntry.id,
    direction,
    sessions: peerEntries.filter((entry: any) => entry.kind === "session").map((entry: any) => ({ id: entry.id })),
    services: peerEntries.filter((entry: any) => entry.kind === "service").map((entry: any) => ({ id: entry.id })),
  });
  if (!moved) {
    host.footerFlash = "Already at edge";
    host.footerFlashTicks = 2;
    host.renderDashboard();
    return true;
  }

  host.dashboardWorktreeGroupsCache = host.dashboardUiStateStore.orderWorktreeGroups(host.dashboardWorktreeGroupsCache);
  host.updateWorktreeSessions();
  const nextIndex = host.dashboardState.worktreeEntries.findIndex(
    (entry: any) => entry.kind === selectedEntry.kind && entry.id === selectedEntry.id,
  );
  if (nextIndex >= 0) host.dashboardState.sessionIndex = nextIndex;
  host.preferDashboardEntrySelection(selectedEntry.kind, selectedEntry.id, host.dashboardState.focusedWorktreePath);
  host.persistDashboardUiState();
  void mutateDashboardApi(host, PROJECT_API_ROUTES.statuslineRefresh, { force: true }).catch(() => undefined);
  host.footerFlash = `Moved ${selectedEntry.kind === "session" ? "agent" : "service"} ${direction}`;
  host.footerFlashTicks = 2;
  host.renderDashboard();
  return true;
}

function selectedDashboardSession(host: any): DashboardSession | undefined {
  const allSessions = host.getDashboardSessions();
  if (host.dashboardState.level === "sessions" && host.dashboardState.worktreeEntries.length > 0) {
    const entry = host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex];
    if (entry?.kind !== "session") return undefined;
    return allSessions.find((session: DashboardSession) => session.id === entry.id);
  }
  if (!host.dashboardState.hasWorktrees()) {
    return allSessions[host.activeIndex];
  }
  return undefined;
}

function teammateParentSession(host: any): DashboardSession | undefined {
  const parentId = host.teammatePickerState?.parentSessionId;
  const selected = selectedDashboardSession(host);
  if (parentId) {
    const parent =
      host.dashboardSessionsCache?.find((session: DashboardSession) => session.id === parentId) ??
      (selected?.id === parentId ? selected : undefined);
    if (parent && !isTeammateSession(parent)) return parent;
    return undefined;
  }
  if (selected && !isTeammateSession(selected)) return selected;
  return undefined;
}

function teammatePickerEntries(host: any): DashboardSession[] {
  return selectDashboardTeammates(host.dashboardTeammatesCache ?? [], teammateParentSession(host));
}

function teammatePickerVisibleCount(total: number): number {
  return Math.min(total, Math.max(3, (process.stdout.rows ?? 24) - 10));
}

export const dashboardInteractionMethods = {
  clearDashboardQuickJump(this: any): void {
    this.dashboardState.quickJumpDigits = "";
  },

  focusDashboardQuickJumpWorktree(this: any, worktreePath: string | undefined): void {
    this.dashboardState.focusedWorktreePath = worktreePath;
    this.dashboardState.level = "worktrees";
    this.dashboardUiStateStore.markSelectionDirty();
    this.renderDashboard();
  },

  focusDashboardQuickJumpEntry(
    this: any,
    worktreePath: string | undefined,
    entryIndex: number,
    opts?: { render?: boolean; persist?: boolean },
  ): void {
    this.dashboardState.focusedWorktreePath = worktreePath;
    this.updateWorktreeSessions();
    this.dashboardState.level = "sessions";
    this.dashboardState.sessionIndex = Math.max(
      0,
      Math.min(entryIndex, this.dashboardState.worktreeEntries.length - 1),
    );
    const selectedEntry = this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex];
    if (selectedEntry) {
      this.preferDashboardEntrySelection(selectedEntry.kind, selectedEntry.id, worktreePath);
    } else {
      this.dashboardUiStateStore.markSelectionDirty();
    }
    if (opts?.persist !== false) {
      this.persistDashboardUiState();
    }
    if (opts?.render !== false) {
      this.renderDashboard();
    }
  },

  activateSelectedDashboardWorktreeEntry(this: any): void {
    const selectedEntry = refreshSelectedWorktreeEntry(this);
    if (!selectedEntry) return;
    const focusedGroup = findDashboardWorktreeGroup(this, this.dashboardState.focusedWorktreePath);
    if (isRemovingDashboardWorktree(focusedGroup)) {
      this.footerFlash = blockedRemovingWorktreeMessage(focusedGroup, this.dashboardState.focusedWorktreePath);
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return;
    }
    if (selectedEntry.kind === "service") {
      const service = this.getDashboardServices().find((entry: any) => entry.id === selectedEntry.id);
      if (!service) return;
      void this.activateDashboardService(service);
      return;
    }
    const dashEntry = this.dashboardState.worktreeSessions.find((entry: any) => entry.id === selectedEntry.id);
    if (!dashEntry) return;
    void this.activateDashboardEntry(dashEntry);
  },

  handleDashboardQuickJumpDigit(this: any, key: string): boolean {
    if (key < "1" || key > "9") return false;
    this.clearDashboardQuickJump();
    const digit = Number.parseInt(key, 10);

    if (this.dashboardState.level === "sessions") {
      this.updateWorktreeSessions();
      const entryIndex = digit - 1;
      if (entryIndex < 0 || entryIndex >= this.dashboardState.worktreeEntries.length) return true;
      this.dashboardState.sessionIndex = entryIndex;
      const selectedEntry = this.dashboardState.worktreeEntries[entryIndex];
      if (selectedEntry) {
        this.preferDashboardEntrySelection(
          selectedEntry.kind,
          selectedEntry.id,
          this.dashboardState.focusedWorktreePath,
        );
        this.persistDashboardUiState();
      }
      this.activateSelectedDashboardWorktreeEntry();
      return true;
    }

    const worktrees = buildDashboardQuickJumpWorktrees({
      sessions: this.dashboardSessionsCache.filter((s: DashboardSession) => !isOverseerSession(s)),
      services: this.dashboardServicesCache,
      worktreeGroups: this.dashboardWorktreeGroupsCache,
      mainCheckout: this.dashboardMainCheckoutInfoCache,
    });

    const worktree = worktrees.find((entry) => entry.digit === digit);
    if (!worktree) return true;
    this.dashboardRenderOptions = {
      skipStatusline: true,
      skipPersist: true,
    };
    this.focusDashboardQuickJumpWorktree(worktree.path);
    return true;
  },

  handleDashboardKey(this: any, data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    if (events.length > 1) {
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const beforeMode = this.mode;
        const beforeOverlay = this.dashboardOverlayState?.kind ?? "none";
        const key = commandKey(event);
        const activatesVisibleDashboardEntry =
          this.isDashboardScreen("dashboard") &&
          this.dashboardState?.hasWorktrees?.() &&
          this.dashboardState.level === "sessions" &&
          key >= "1" &&
          key <= "9";
        dashboardInteractionMethods.handleDashboardKey.call(this, Buffer.from(event.raw));
        const afterOverlay = this.dashboardOverlayState?.kind ?? "none";
        if (
          this.mode !== beforeMode ||
          afterOverlay !== beforeOverlay ||
          activatesVisibleDashboardEntry ||
          key === "enter" ||
          key === "right" ||
          key === "l" ||
          key === "q"
        ) {
          const nextEvent = events[index + 1];
          if (
            nextEvent &&
            this.mode === beforeMode &&
            afterOverlay === beforeOverlay &&
            shouldContinueCoalescedDashboardInputAfterActivation(this, key, nextEvent)
          ) {
            continue;
          }
          break;
        }
      }
      return;
    }

    const event = events[0];
    const key = commandKey(event);
    const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");
    const hasWorktrees = this.dashboardState.hasWorktrees();

    if (hasWorktrees && this.isDashboardScreen("dashboard") && this.handleDashboardQuickJumpDigit(key)) {
      return;
    }

    if (!hasWorktrees && key >= "1" && key <= "9") {
      const index = parseInt(key, 10) - 1;
      void this.activateDashboardEntryByNumber(index);
      return;
    }

    if (isTabToggle) {
      this.dashboardState.toggleDetailsSidebar();
      this.dashboard.toggleDetailsPane();
      this.renderCurrentDashboardView();
      return;
    }

    if (hasWorktrees && this.isDashboardScreen("dashboard") && event.shift && (key === "up" || key === "down")) {
      if (moveSelectedDashboardWorktreeEntry(this, key)) {
        return;
      }
    }

    if (
      this.isDashboardScreen("dashboard") &&
      isPlainDashboardNavigationEvent(event, key) &&
      handleDashboardNavigationKey(this, key, hasWorktrees)
    ) {
      return;
    }

    if (key === "s") {
      this.showOrchestrationRoutePicker("message");
      return;
    }
    if (isShiftedCommand(event, key, "h")) {
      this.showOrchestrationRoutePicker("handoff");
      return;
    }
    if (isShiftedCommand(event, key, "t")) {
      this.showOrchestrationRoutePicker("task");
      return;
    }
    if (isShiftedCommand(event, key, "l")) {
      this.showLibrary();
      return;
    }
    if (isShiftedCommand(event, key, "w")) {
      this.showWorktreeList();
      return;
    }
    if (isShiftedCommand(event, key, "r")) {
      const selected = this.getSelectedDashboardSessionForActions();
      if (selected) {
        if ((selected.threadWaitingOnMeCount ?? 0) > 0) {
          void this.openRelevantThreadForSession(selected.id);
        } else {
          this.footerFlash = `Nothing waiting on you for ${selected.label ?? selected.command}`;
          this.footerFlashTicks = 3;
          this.renderDashboard();
        }
      }
      return;
    }

    switch (key) {
      case "?":
        this.showHelp();
        return;
      case "n":
        this.showToolPicker();
        return;
      case "c":
        this.showCoordination();
        return;
      case "v":
        this.showServiceCreatePrompt();
        return;
      case "e":
        this.showTeammatePicker();
        return;
      case "f": {
        const selected = this.getSelectedDashboardSessionForActions();
        if (selected) {
          this.showToolPicker(selected.id);
        } else if (hasWorktrees && this.dashboardState.level === "worktrees") {
          this.showDashboardError("Select an agent to fork", [
            "Press Enter to step into a worktree, then select a session and press [f] to fork it.",
          ]);
        }
        return;
      }
      case "o": {
        const selected = this.getSelectedDashboardSessionForActions();
        if (selected) {
          void this.openRelevantThreadForSession(selected.id);
        }
        return;
      }
      case "q":
        this.exitDashboardClientOrProcess();
        return;
      case "w":
        this.showWorktreeCreatePrompt();
        return;
      case "g":
        this.showGraveyard();
        return;
      case "p":
        this.showProject();
        return;
      case "t":
        this.showTopology();
        return;
      case "u":
        void this.activateNextAttentionEntry();
        return;
      case "x": {
        if (hasWorktrees && this.dashboardState.level === "worktrees" && this.dashboardState.focusedWorktreePath) {
          const focusedGroup = this.dashboardWorktreeGroupsCache.find(
            (group: any) => group.path === this.dashboardState.focusedWorktreePath,
          );
          if (isRemovingDashboardWorktree(focusedGroup)) {
            this.footerFlash = blockedRemovingWorktreeMessage(focusedGroup, this.dashboardState.focusedWorktreePath);
            this.footerFlashTicks = 2;
            this.renderDashboard();
            return;
          }
          if (focusedGroup?.pending) {
            this.footerFlash = `Worktree ${focusedGroup.name ?? focusedGroup.path.split("/").pop() ?? "worktree"} is ${focusedGroup.pendingAction ?? "pending"}`;
            this.footerFlashTicks = 2;
            this.renderDashboard();
            return;
          }
          if (isFailedDashboardWorktree(focusedGroup)) {
            const modelLifecycle = captureDashboardLifecycle(this);
            const lifecycle = captureDashboardLifecycle(this, { inputEpoch: true });
            this.footerFlash = `Dismissed failure for ${focusedGroup.name ?? "worktree"}`;
            this.footerFlashTicks = 3;
            this.renderDashboard();
            void mutateDashboardApi(this, PROJECT_API_ROUTES.operationFailuresClear, {
              targetKind: "worktree",
              operation: focusedGroup.operationFailure.operation,
              worktreePath: this.dashboardState.focusedWorktreePath,
            })
              .then(async () => {
                await refreshDashboardModelThroughApi(this, { force: true, lifecycle: modelLifecycle });
                renderDashboardIfCurrent(this, lifecycle, () => this.renderDashboard());
              })
              .catch((error: unknown) => {
                if (!isDashboardLifecycleCurrent(this, lifecycle)) return;
                this.showDashboardError("Failed to dismiss worktree failure", [
                  error instanceof Error ? error.message : String(error),
                ]);
              });
            return;
          }
          const wtName =
            this.dashboardState.focusedWorktreePath.split("/").pop() ?? this.dashboardState.focusedWorktreePath;
          this.worktreeRemoveConfirm = { path: this.dashboardState.focusedWorktreePath, name: wtName };
          this.openDashboardOverlay("worktree-remove-confirm");
          this.renderWorktreeRemoveConfirm();
          return;
        }

        const selectedService = this.getSelectedDashboardServiceForActions();
        if (selectedService) {
          if (
            hasBlockingPendingDashboardAction(selectedService) &&
            !isStoppableStartingService(this, selectedService)
          ) {
            flashPendingDashboardItem(this, selectedService, "service");
            return;
          }
          if (isStoppableStartingService(this, selectedService)) {
            void this.stopDashboardServiceWithFeedback(selectedService);
          } else if (selectedService.status === "offline") {
            void this.removeDashboardServiceWithFeedback(selectedService);
          } else {
            void this.stopDashboardServiceWithFeedback(selectedService);
          }
          return;
        }

        const allDs = this.getDashboardSessions();
        const selId =
          this.dashboardState.level === "sessions" && this.dashboardState.worktreeEntries.length > 0
            ? this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex]?.kind === "session"
              ? this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex]?.id
              : undefined
            : undefined;
        const selEntry = selId
          ? allDs.find((d: any) => d.id === selId)
          : !hasWorktrees
            ? allDs[this.activeIndex]
            : undefined;
        if (!selEntry) return;
        if (hasBlockingPendingDashboardAction(selEntry)) {
          flashPendingDashboardItem(this, selEntry, "agent");
          return;
        }

        const runtime = this.sessions.find((s: any) => s.id === selEntry.id);
        if (selEntry.status !== "offline" && selEntry.pendingAction !== "stopping" && this.mode === "dashboard") {
          void this.stopSessionToOfflineWithFeedback(runtime ?? selEntry);
          return;
        }
        const effectivelyOffline =
          selEntry.status === "offline" ||
          selEntry.pendingAction === "stopping" ||
          !runtime ||
          !this.isSessionRuntimeLive(runtime);

        if (effectivelyOffline) {
          void this.graveyardSessionWithFeedback(selEntry.id, hasWorktrees);
          return;
        }
        const pty = runtime;
        if (pty) {
          void this.stopSessionToOfflineWithFeedback(pty);
        }
        return;
      }
      case "m":
        if (this.sessions.length > 0) {
          const selected = this.getSelectedDashboardSessionForActions();
          this.showMigratePicker(selected?.id);
        }
        return;
      case "r": {
        const allDs2 = this.getDashboardSessions();
        const selId2 =
          this.dashboardState.level === "sessions" && this.dashboardState.worktreeEntries.length > 0
            ? this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex]?.kind === "session"
              ? this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex]?.id
              : undefined
            : undefined;
        const selEntry2 = selId2
          ? allDs2.find((d: any) => d.id === selId2)
          : !hasWorktrees
            ? allDs2[this.activeIndex]
            : undefined;
        if (selEntry2) {
          this.openDashboardOverlay("label-input");
          this.labelInputBuffer = this.getSessionLabel(selEntry2.id) ?? "";
          this.labelInputTarget = selEntry2.id;
          this.renderLabelInput();
        }
        return;
      }
    }
  },

  async activateDashboardEntryByNumber(this: any, index: number): Promise<void> {
    const entry = this.getDashboardSessionsInVisualOrder()[index];
    if (!entry) return;
    await this.activateDashboardEntry(entry);
  },

  async activateDashboardService(this: any, service: DashboardService): Promise<DashboardActivationResult> {
    if (!service) return "missing";
    const activationToken = beginDashboardActivation(this, "service", service.id);
    const worktreeGroup = findDashboardWorktreeGroup(this, service.worktreePath);
    if (isRemovingDashboardWorktree(worktreeGroup)) {
      this.footerFlash = blockedRemovingWorktreeMessage(worktreeGroup, service.worktreePath);
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return "blocked";
    }
    if (hasBlockingPendingDashboardAction(service)) {
      flashPendingDashboardItem(this, service, "service");
      return "blocked";
    }

    this.preferDashboardEntrySelection("service", service.id, service.worktreePath);
    this.persistDashboardUiState();
    if (service.status !== "running") {
      this.dashboardActivatingServiceIds ??= new Set<string>();
      this.dashboardActivatingServiceIds.add(service.id);
      try {
        const resumeResult = await this.resumeOfflineServiceWithFeedback(service);
        if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
        if (resumeResult === "pending") return "pending";
        if (resumeResult === "failed") return "error";
        const serviceForOpen =
          this.getDashboardServices?.().find((entry: DashboardService) => entry.id === service.id) ?? service;
        const result = await this.waitAndOpenLiveTmuxWindowForService(serviceForOpen, 60_000);
        if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
        void refreshDashboardAfterServiceOpen(this, activationToken);
        if (result !== "opened") {
          this.footerFlash = `Service ${service.label ?? service.command ?? service.id} is not available yet`;
          this.footerFlashTicks = 3;
          this.renderDashboard();
        }
        return result;
      } finally {
        this.dashboardActivatingServiceIds.delete(service.id);
      }
    }
    const openResult = await this.waitAndOpenLiveTmuxWindowForService(service);
    if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
    if (openResult !== "opened") {
      await refreshDashboardModelThroughApi(this, { force: true });
      if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
      if (openResult === "missing") {
        this.footerFlash = `Service ${service.label ?? service.command ?? service.id} is not available yet`;
        this.footerFlashTicks = 3;
      }
      this.renderDashboard();
    }
    return openResult;
  },

  async activateDashboardEntry(
    this: any,
    entry: DashboardSession,
    options: { preserveDashboardSelection?: boolean } = {},
  ): Promise<DashboardActivationResult> {
    if (!entry) return "missing";
    const activationToken = beginDashboardActivation(this, "session", entry.id);
    const worktreeGroup = findDashboardWorktreeGroup(this, entry.worktreePath);
    if (isRemovingDashboardWorktree(worktreeGroup)) {
      this.footerFlash = blockedRemovingWorktreeMessage(worktreeGroup, entry.worktreePath);
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return "blocked";
    }
    if (hasBlockingPendingDashboardAction(entry)) {
      flashPendingDashboardItem(this, entry, "agent");
      return "blocked";
    }

    if (!options.preserveDashboardSelection) {
      this.preferDashboardEntrySelection("session", entry.id, entry.worktreePath);
      this.persistDashboardUiState();
    }

    if (isBlockedOfflineSession(entry)) {
      flashBlockedOfflineSession(this, entry);
      return "blocked";
    }

    if (this.mode === "dashboard" && (entry.status === "offline" || entry.status === "exited")) {
      const resumeResult = await this.resumeOfflineSessionWithFeedback(
        this.offlineSessions?.find((session: any) => session.id === entry.id) ?? entry,
      );
      if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
      if (resumeResult === "pending") return "pending";
      if (resumeResult === "failed") return "error";
      await refreshDashboardModelThroughApi(this, { force: true });
      if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
      this.renderDashboard();
      return "opened";
    }

    const openResult = await this.waitAndOpenLiveTmuxWindowForEntry(entry);
    if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
    if (openResult !== "missing") {
      if (entry.status === "offline" || entry.status === "exited") {
        await refreshDashboardModelThroughApi(this, { force: true });
        if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
        this.renderDashboard();
      }
      return openResult;
    }

    if (this.mode === "dashboard") {
      await refreshDashboardModelThroughApi(this, { force: true });
      if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
      this.footerFlash = `Agent ${entry.label ?? entry.command ?? entry.id} is not available yet`;
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return "missing";
    }

    if (entry.status === "offline" || entry.status === "exited") {
      const offline = this.offlineSessions.find((session: any) => session.id === entry.id);
      if (isBlockedOfflineSession(offline ?? entry)) {
        flashBlockedOfflineSession(this, offline ?? entry);
        return "blocked";
      }
      const resumeResult = await this.resumeOfflineSessionWithFeedback(offline ?? entry);
      if (!isCurrentDashboardActivation(this, activationToken)) return "missing";
      if (resumeResult === "pending") return "pending";
      if (resumeResult === "failed") return "error";
      return "opened";
    }

    const ptyIdx = this.sessions.findIndex((session: any) => session.id === entry.id);
    if (ptyIdx >= 0) {
      this.noteLastUsedItem(entry.id);
      this.focusSession(ptyIdx);
      return "opened";
    }
    return "missing";
  },

  getTeammatePickerEntries(this: any): DashboardSession[] {
    return teammatePickerEntries(this);
  },

  showTeammatePicker(this: any): void {
    const parent = teammateParentSession(this);
    if (!parent) {
      this.footerFlash = "Select an agent with teammates";
      this.footerFlashTicks = 2;
      this.renderDashboard();
      return;
    }
    const teammates = selectDashboardTeammates(this.dashboardTeammatesCache ?? [], parent);
    if (teammates.length === 0) {
      this.footerFlash = `${parent.label ?? parent.command} has no teammates`;
      this.footerFlashTicks = 2;
      this.renderDashboard();
      return;
    }
    this.teammatePickerState = { parentSessionId: parent.id, index: 0 };
    this.openDashboardOverlay("teammate-picker");
    this.renderTeammatePicker();
  },

  renderTeammatePicker(this: any): void {
    this.redrawDashboardWithOverlay();
  },

  handleTeammatePickerKey(this: any, data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const event = events[0];
    const key = commandKey(event);
    const teammates = teammatePickerEntries(this);
    const visibleTeammates = teammates.slice(0, teammatePickerVisibleCount(teammates.length));
    const selectedIndex = Math.max(0, Math.min(this.teammatePickerState?.index ?? 0, visibleTeammates.length - 1));

    if (key === "escape") {
      this.teammatePickerState = null;
      this.clearDashboardOverlay();
      this.restoreDashboardAfterOverlayDismiss();
      return;
    }

    if (visibleTeammates.length === 0) {
      this.teammatePickerState = null;
      this.clearDashboardOverlay();
      this.restoreDashboardAfterOverlayDismiss();
      return;
    }

    if (key === "down" || key === "j") {
      this.teammatePickerState = {
        parentSessionId: this.teammatePickerState?.parentSessionId ?? teammateParentSession(this)?.id ?? "",
        index: ((this.teammatePickerState?.index ?? 0) + 1) % visibleTeammates.length,
      };
      this.renderTeammatePicker();
      return;
    }

    if (key === "up" || key === "k") {
      this.teammatePickerState = {
        parentSessionId: this.teammatePickerState?.parentSessionId ?? teammateParentSession(this)?.id ?? "",
        index: ((this.teammatePickerState?.index ?? 0) - 1 + visibleTeammates.length) % visibleTeammates.length,
      };
      this.renderTeammatePicker();
      return;
    }

    let targetIndex: number | undefined;
    if (key === "enter" || key === "return") {
      targetIndex = selectedIndex;
    } else if (key >= "1" && key <= "9") {
      targetIndex = parseInt(key, 10) - 1;
    }
    if (targetIndex === undefined) return;

    const teammate = visibleTeammates[targetIndex];
    if (!teammate) return;
    this.teammatePickerState = null;
    this.clearDashboardOverlay();
    void this.activateDashboardEntry(teammate, { preserveDashboardSelection: true });
  },

  handleServiceInputKey(this: any, data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    for (const event of events) {
      const key = commandKey(event);

      if (key === "escape") {
        this.clearDashboardOverlay();
        this.restoreDashboardAfterOverlayDismiss();
        return;
      }

      if (key === "enter" || key === "return") {
        this.clearDashboardOverlay();
        if (this.mode !== "dashboard") {
          this.showDashboardError("Failed to create service", ["Service creation requires the project service."]);
          return;
        }
        void this.createDashboardServiceWithFeedback(this.serviceInputBuffer, this.dashboardState.focusedWorktreePath);
        this.restoreDashboardAfterOverlayDismiss();
        return;
      }

      if (key === "backspace" || key === "delete") {
        this.serviceInputBuffer = this.serviceInputBuffer.slice(0, -1);
        this.renderServiceInput();
        continue;
      }

      const text = printableInputText(event);
      if (text) {
        this.serviceInputBuffer += text;
        this.renderServiceInput();
      }
    }
  },

  handleLabelInputKey(this: any, data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    for (const event of events) {
      const key = commandKey(event);

      if (key === "escape") {
        this.clearDashboardOverlay();
        this.labelInputTarget = null;
        this.restoreDashboardAfterOverlayDismiss();
        return;
      }

      if (key === "enter" || key === "return") {
        this.clearDashboardOverlay();
        const label = this.labelInputBuffer.trim();
        const targetId = this.labelInputTarget;
        this.labelInputTarget = null;
        if (targetId) {
          void this.updateSessionLabel(targetId, label || undefined);
          return;
        }
        this.restoreDashboardAfterOverlayDismiss();
        return;
      }

      if (key === "backspace" || key === "delete") {
        this.labelInputBuffer = this.labelInputBuffer.slice(0, -1);
        this.renderLabelInput();
        continue;
      }

      const text = printableInputText(event);
      if (text) {
        this.labelInputBuffer += text;
        this.renderLabelInput();
      }
    }
  },

  async handleReviewRequest(this: any): Promise<void> {
    const session = this.activeSession;
    if (!session) return;

    const role = this.sessionRoles.get(session.id) ?? "coder";
    const team = loadDashboardTeamConfig();
    const roleConfig = team.roles[role];
    let reviewerRole = roleConfig?.reviewedBy;
    if (!reviewerRole || reviewerRole === role) {
      const fallback = Object.entries(team.roles)
        .filter(([roleKey]) => roleKey !== role)
        .find(([, cfg]) => cfg.description.toLowerCase().includes("review"));
      reviewerRole =
        fallback?.[0] ?? Object.entries(team.roles).find(([roleKey, cfg]) => roleKey !== role && cfg.canEdit)?.[0];
    }
    if (!reviewerRole) {
      this.footerFlash = "No reviewer role configured";
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return;
    }
    const worktreePath = this.sessionWorktreePaths?.get?.(session.id);
    const reviewCwd = worktreePath ?? this.projectRoot ?? process.cwd();
    let diff: string | undefined;
    try {
      diff =
        execSync("git diff HEAD", { cwd: reviewCwd, encoding: "utf-8", timeout: 5000 }).slice(0, 5000) || undefined;
    } catch {}

    try {
      const result = await mutateDashboardApi(this, PROJECT_API_ROUTES.tasks.assign, {
        from: session.id,
        assignee: reviewerRole,
        description: `Review: Review ${session.command} agent's recent work`,
        prompt: `Review ${session.command} agent's recent work`,
        type: "review",
        diff,
        worktreePath,
        assigner: role,
        reviewOf: session.id,
        iteration: 1,
      });
      const assignee = result?.task?.assignee ?? reviewerRole;
      this.footerFlash = `⧫ Review requested → ${assignee}`;
      this.footerFlashTicks = 3;
    } catch (error) {
      this.showDashboardError("Failed to request review", [error instanceof Error ? error.message : String(error)]);
      return;
    } finally {
      this.renderDashboard();
    }
  },

  formatRoutePreview(this: any, recipientIds: string[]): string {
    if (recipientIds.length === 0) return "";
    const preview = recipientIds.slice(0, 2).join(", ");
    const remainder = recipientIds.length > 2 ? `, +${recipientIds.length - 2}` : "";
    return ` [${recipientIds.length}: ${preview}${remainder}]`;
  },

  async submitDashboardOrchestrationAction(
    this: any,
    mode: "message" | "handoff" | "task",
    target: any,
    body: string,
    lifecycle: DashboardLifecycleToken = captureDashboardLifecycle(this),
  ): Promise<void> {
    try {
      let successFlash = "";
      const requestBody = {
        from: "user",
        to: target.sessionId ? [target.sessionId] : undefined,
        assignee: target.assignee,
        tool: target.tool,
        worktreePath: target.worktreePath,
      };
      if (mode === "message") {
        await mutateDashboardApi(this, PROJECT_API_ROUTES.threads.send, {
          kind: "request",
          ...requestBody,
          body,
        });
        const count = target.sessionId ? 1 : (target.recipientIds?.length ?? 0);
        successFlash = `Sent message to ${count} recipient${count === 1 ? "" : "s"}`;
      } else if (mode === "handoff") {
        await mutateDashboardApi(this, PROJECT_API_ROUTES.handoff.send, {
          ...requestBody,
          body,
        });
        successFlash = `Sent handoff to ${target.label}`;
      } else {
        await mutateDashboardApi(this, PROJECT_API_ROUTES.tasks.assign, {
          ...requestBody,
          description: body,
        });
        successFlash = `Assigned task to ${target.label}`;
      }
      if (!isDashboardLifecycleCurrent(this, lifecycle)) return;
      this.footerFlash = successFlash;
      this.footerFlashTicks = 3;
      this.clearDashboardOverlay();
      this.orchestrationInputBuffer = "";
      this.orchestrationInputTarget = null;
      this.orchestrationInputMode = null;
    } catch (error) {
      if (!isDashboardLifecycleCurrent(this, lifecycle)) return;
      this.clearDashboardOverlay();
      this.orchestrationInputBuffer = "";
      this.orchestrationInputTarget = null;
      this.orchestrationInputMode = null;
      this.showDashboardError(
        `Failed to ${mode === "task" ? "assign task" : mode === "handoff" ? "send handoff" : "send message"}`,
        [error instanceof Error ? error.message : String(error)],
      );
      return;
    }
    renderDashboardIfCurrent(this, lifecycle, () => this.renderDashboard());
  },
};

export type DashboardInteractionMethods = typeof dashboardInteractionMethods;
