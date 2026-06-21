import { execSync } from "node:child_process";
import type { DashboardService, DashboardSession } from "../dashboard/index.js";
import {
  DASHBOARD_QUICK_JUMP_TIMEOUT_MS,
  buildDashboardQuickJumpWorktrees,
  resolveDashboardQuickJumpTarget,
} from "../dashboard/quick-jump.js";
import { selectDashboardTeammates } from "../dashboard/session-registry.js";
import { commandKey, parseKeys } from "../key-parser.js";
import { isBlockingPendingDashboardActionKind } from "../pending-actions.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import {
  getDefaultTeamConfig,
  isTeammateSession,
  isOverseerSession,
  loadTeamConfig,
  type TeamConfig,
} from "../team.js";

function hasBlockingPendingDashboardAction(entry: { pendingAction?: string } | null | undefined): boolean {
  return isBlockingPendingDashboardActionKind(entry?.pendingAction);
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
  void host.postToProjectService?.(PROJECT_API_ROUTES.statuslineRefresh, { force: true }).catch(() => {});
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
    if (this.dashboardQuickJumpTimeout) {
      clearTimeout(this.dashboardQuickJumpTimeout);
      this.dashboardQuickJumpTimeout = null;
    }
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

  commitDashboardQuickJump(this: any, digits?: string): boolean {
    const buffered = digits ?? this.dashboardState.quickJumpDigits;
    this.clearDashboardQuickJump();
    if (!buffered) return false;
    const target = resolveDashboardQuickJumpTarget(
      buildDashboardQuickJumpWorktrees({
        sessions: this.dashboardSessionsCache.filter((s: DashboardSession) => !isOverseerSession(s)),
        services: this.dashboardServicesCache,
        worktreeGroups: this.dashboardWorktreeGroupsCache,
        mainCheckout: this.dashboardMainCheckoutInfoCache,
      }),
      buffered,
    );
    if (!target) return false;
    if (target.kind === "entry") {
      this.focusDashboardQuickJumpEntry(target.worktree.path, target.entryIndex, { render: false });
      this.activateSelectedDashboardWorktreeEntry();
    } else {
      this.focusDashboardQuickJumpWorktree(target.worktree.path);
    }
    return true;
  },

  handleDashboardQuickJumpDigit(this: any, key: string): boolean {
    if (key < "1" || key > "9") return false;
    const nextDigits = `${this.dashboardState.quickJumpDigits}${key}`.slice(0, 2);
    this.clearDashboardQuickJump();
    if (nextDigits.length === 1) {
      const target = resolveDashboardQuickJumpTarget(
        buildDashboardQuickJumpWorktrees({
          sessions: this.dashboardSessionsCache.filter((s: DashboardSession) => !isOverseerSession(s)),
          services: this.dashboardServicesCache,
          worktreeGroups: this.dashboardWorktreeGroupsCache,
          mainCheckout: this.dashboardMainCheckoutInfoCache,
        }),
        nextDigits,
      );
      if (target?.kind === "worktree") {
        this.dashboardRenderOptions = {
          skipStatusline: true,
          skipPersist: true,
        };
        this.focusDashboardQuickJumpWorktree(target.worktree.path);
      }
      this.dashboardState.quickJumpDigits = nextDigits;
      this.dashboardQuickJumpTimeout = setTimeout(() => {
        void this.commitDashboardQuickJump(nextDigits);
      }, DASHBOARD_QUICK_JUMP_TIMEOUT_MS);
      return true;
    }
    return this.commitDashboardQuickJump(nextDigits);
  },

  handleDashboardKey(this: any, data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = commandKey(event);
    const lowerKey = commandKey(event);
    const isTabToggle = lowerKey === "tab" || event.raw === "\t" || (event.ctrl && lowerKey === "i");
    const hasWorktrees = this.dashboardState.hasWorktrees();

    if (hasWorktrees && this.dashboardState.quickJumpDigits && !(lowerKey >= "1" && lowerKey <= "9")) {
      this.commitDashboardQuickJump();
    }

    if (hasWorktrees && this.isDashboardScreen("dashboard") && this.handleDashboardQuickJumpDigit(lowerKey)) {
      return;
    }

    if (!hasWorktrees && lowerKey >= "1" && lowerKey <= "9") {
      const index = parseInt(lowerKey, 10) - 1;
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

    if (lowerKey === "s") {
      this.showOrchestrationRoutePicker("message");
      return;
    }
    if (lowerKey === "h") {
      this.showOrchestrationRoutePicker("handoff");
      return;
    }
    if (key === "T") {
      this.showOrchestrationRoutePicker("task");
      return;
    }
    if (key === "W") {
      this.showWorktreeList();
      return;
    }
    if (key === "R") {
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

    switch (lowerKey) {
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
      case "l":
        this.showLibrary();
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
            this.footerFlash = `Dismissed failure for ${focusedGroup.name ?? "worktree"}`;
            this.footerFlashTicks = 3;
            this.renderDashboard();
            void this.postToProjectService(PROJECT_API_ROUTES.operationFailuresClear, {
              targetKind: "worktree",
              operation: focusedGroup.operationFailure.operation,
              worktreePath: this.dashboardState.focusedWorktreePath,
            })
              .then(async () => {
                await this.refreshDashboardModelFromService(true);
                this.renderDashboard();
              })
              .catch((error: unknown) => {
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
          if (hasBlockingPendingDashboardAction(selectedService)) {
            flashPendingDashboardItem(this, selectedService, "service");
            return;
          }
          if (selectedService.status === "offline") {
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

    if (!hasWorktrees) {
      const totalCount = this.getDashboardSessions().length;
      switch (key) {
        case "down":
        case "j":
          if (totalCount > 1) {
            this.activeIndex = (this.activeIndex + 1) % totalCount;
            this.renderDashboard();
          }
          break;
        case "up":
        case "k":
          if (totalCount > 1) {
            this.activeIndex = (this.activeIndex - 1 + totalCount) % totalCount;
            this.renderDashboard();
          }
          break;
        case "enter": {
          const ds = this.getDashboardSessions();
          const entry = ds[this.activeIndex];
          if (entry) {
            void this.activateDashboardEntry(entry);
            return;
          }
          if (this.sessions.length > 0) {
            this.focusSession(this.activeIndex);
          }
          break;
        }
        case "escape":
          if (this.sessions.length > 0) {
            this.focusSession(this.activeIndex);
          }
          break;
      }
      return;
    }

    if (this.dashboardState.level === "worktrees") {
      switch (key) {
        case "down":
        case "j": {
          const curIdx = this.dashboardState.worktreeNavOrder.indexOf(this.dashboardState.focusedWorktreePath);
          this.dashboardState.focusedWorktreePath =
            this.dashboardState.worktreeNavOrder[(curIdx + 1) % this.dashboardState.worktreeNavOrder.length];
          this.renderDashboard();
          break;
        }
        case "up":
        case "k": {
          const curIdx = this.dashboardState.worktreeNavOrder.indexOf(this.dashboardState.focusedWorktreePath);
          this.dashboardState.focusedWorktreePath =
            this.dashboardState.worktreeNavOrder[
              (curIdx - 1 + this.dashboardState.worktreeNavOrder.length) % this.dashboardState.worktreeNavOrder.length
            ];
          this.renderDashboard();
          break;
        }
        case "enter":
        case "right": {
          const focusedGroup = findDashboardWorktreeGroup(this, this.dashboardState.focusedWorktreePath);
          if (isCreatingDashboardWorktree(focusedGroup)) {
            this.footerFlash = creatingWorktreeMessage(focusedGroup, this.dashboardState.focusedWorktreePath);
            this.footerFlashTicks = 3;
            this.renderDashboard();
            break;
          }
          if (isRemovingDashboardWorktree(focusedGroup)) {
            this.footerFlash = blockedRemovingWorktreeMessage(focusedGroup, this.dashboardState.focusedWorktreePath);
            this.footerFlashTicks = 3;
            this.renderDashboard();
            break;
          }
          if (isFailedDashboardWorktree(focusedGroup)) {
            this.footerFlash = failedWorktreeMessage(focusedGroup, this.dashboardState.focusedWorktreePath);
            this.footerFlashTicks = 4;
            this.renderDashboard();
            break;
          }
          this.updateWorktreeSessions();
          if (this.dashboardState.worktreeEntries.length > 0) {
            this.dashboardState.level = "sessions";
            this.dashboardState.sessionIndex = 0;
            this.renderDashboard();
          }
          break;
        }
        case "escape":
          if (this.sessions.length > 0) {
            this.focusSession(this.activeIndex);
          }
          break;
      }
    } else {
      switch (key) {
        case "down":
        case "j":
          if (this.dashboardState.worktreeEntries.length > 1) {
            this.dashboardState.sessionIndex =
              (this.dashboardState.sessionIndex + 1) % this.dashboardState.worktreeEntries.length;
            this.renderDashboard();
          }
          break;
        case "up":
        case "k":
          if (this.dashboardState.worktreeEntries.length > 1) {
            this.dashboardState.sessionIndex =
              (this.dashboardState.sessionIndex - 1 + this.dashboardState.worktreeEntries.length) %
              this.dashboardState.worktreeEntries.length;
            this.renderDashboard();
          }
          break;
        case "enter": {
          this.activateSelectedDashboardWorktreeEntry();
          break;
        }
        case "escape":
        case "left":
        case "h":
          this.dashboardState.level = "worktrees";
          this.renderDashboard();
          break;
      }
    }
  },

  async activateDashboardEntryByNumber(this: any, index: number): Promise<void> {
    const entry = this.getDashboardSessionsInVisualOrder()[index];
    if (!entry) return;
    await this.activateDashboardEntry(entry);
  },

  async activateDashboardService(this: any, service: DashboardService): Promise<void> {
    if (!service) return;
    const worktreeGroup = findDashboardWorktreeGroup(this, service.worktreePath);
    if (isRemovingDashboardWorktree(worktreeGroup)) {
      this.footerFlash = blockedRemovingWorktreeMessage(worktreeGroup, service.worktreePath);
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return;
    }
    if (hasBlockingPendingDashboardAction(service)) {
      flashPendingDashboardItem(this, service, "service");
      return;
    }

    this.preferDashboardEntrySelection("service", service.id, service.worktreePath);
    this.persistDashboardUiState();
    if (service.status !== "running") {
      await this.resumeOfflineServiceWithFeedback(service);
      return;
    }
    await this.waitAndOpenLiveTmuxWindowForService(service.id);
  },

  async activateDashboardEntry(
    this: any,
    entry: DashboardSession,
    options: { preserveDashboardSelection?: boolean } = {},
  ): Promise<void> {
    if (!entry) return;
    const worktreeGroup = findDashboardWorktreeGroup(this, entry.worktreePath);
    if (isRemovingDashboardWorktree(worktreeGroup)) {
      this.footerFlash = blockedRemovingWorktreeMessage(worktreeGroup, entry.worktreePath);
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return;
    }
    if (hasBlockingPendingDashboardAction(entry)) {
      flashPendingDashboardItem(this, entry, "agent");
      return;
    }

    if (!options.preserveDashboardSelection) {
      this.preferDashboardEntrySelection("session", entry.id, entry.worktreePath);
      this.persistDashboardUiState();
    }

    const openResult = await this.waitAndOpenLiveTmuxWindowForEntry(entry);
    if (openResult !== "missing") {
      if (entry.status === "offline") {
        await this.refreshDashboardModelFromService?.(true);
        this.renderDashboard();
      }
      return;
    }

    if (this.mode === "dashboard") {
      await this.refreshDashboardModelFromService?.(true);
      this.footerFlash = `Agent ${entry.label ?? entry.command ?? entry.id} is not available yet`;
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return;
    }

    if (entry.status === "offline") {
      const offline = this.offlineSessions.find((session: any) => session.id === entry.id);
      await this.resumeOfflineSessionWithFeedback(offline ?? entry);
      return;
    }

    const ptyIdx = this.sessions.findIndex((session: any) => session.id === entry.id);
    if (ptyIdx >= 0) {
      this.noteLastUsedItem(entry.id);
      this.focusSession(ptyIdx);
    }
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

    const event = events[0];
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
      return;
    }

    if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
      this.serviceInputBuffer += event.char;
      this.renderServiceInput();
    }
  },

  handleLabelInputKey(this: any, data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
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
      return;
    }

    if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
      this.labelInputBuffer += event.char;
      this.renderLabelInput();
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
      const result = await this.postToProjectService(PROJECT_API_ROUTES.tasks.assign, {
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
  ): Promise<void> {
    try {
      const requestBody = {
        from: "user",
        to: target.sessionId ? [target.sessionId] : undefined,
        assignee: target.assignee,
        tool: target.tool,
        worktreePath: target.worktreePath,
      };
      if (mode === "message") {
        await this.postToProjectService(PROJECT_API_ROUTES.threads.send, {
          kind: "request",
          ...requestBody,
          body,
        });
        const count = target.sessionId ? 1 : (target.recipientIds?.length ?? 0);
        this.footerFlash = `Sent message to ${count} recipient${count === 1 ? "" : "s"}`;
      } else if (mode === "handoff") {
        await this.postToProjectService(PROJECT_API_ROUTES.handoff.send, {
          ...requestBody,
          body,
        });
        this.footerFlash = `Sent handoff to ${target.label}`;
      } else {
        await this.postToProjectService(PROJECT_API_ROUTES.tasks.assign, {
          ...requestBody,
          description: body,
        });
        this.footerFlash = `Assigned task to ${target.label}`;
      }
      this.footerFlashTicks = 3;
      this.clearDashboardOverlay();
      this.orchestrationInputBuffer = "";
      this.orchestrationInputTarget = null;
      this.orchestrationInputMode = null;
    } catch (error) {
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
    this.renderDashboard();
  },
};

export type DashboardInteractionMethods = typeof dashboardInteractionMethods;
