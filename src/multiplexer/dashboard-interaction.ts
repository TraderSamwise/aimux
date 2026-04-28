import { execSync } from "node:child_process";
import type { DashboardSession } from "../dashboard/index.js";
import {
  DASHBOARD_QUICK_JUMP_TIMEOUT_MS,
  buildDashboardQuickJumpWorktrees,
  resolveDashboardQuickJumpTarget,
} from "../dashboard/quick-jump.js";
import { parseKeys } from "../key-parser.js";
import { requestReview } from "../task-dispatcher.js";

function hasBlockingPendingDashboardAction(entry: { pendingAction?: string } | null | undefined): boolean {
  return (
    entry?.pendingAction === "creating" ||
    entry?.pendingAction === "forking" ||
    entry?.pendingAction === "migrating" ||
    entry?.pendingAction === "starting"
  );
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
    const selectedEntry = this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex];
    if (!selectedEntry) return;
    if (selectedEntry.kind === "service") {
      const service = this.getDashboardServices().find((entry: any) => entry.id === selectedEntry.id);
      if (!service) return;
      if (hasBlockingPendingDashboardAction(service)) {
        return;
      }
      this.preferDashboardEntrySelection("service", service.id, this.dashboardState.focusedWorktreePath);
      if (service.status !== "running") {
        void this.resumeOfflineServiceWithFeedback(service);
        return;
      }
      if (this.openLiveTmuxWindowForService(selectedEntry.id) !== "missing") {
        return;
      }
      return;
    }
    const dashEntry = this.dashboardState.worktreeSessions.find((entry: any) => entry.id === selectedEntry.id);
    if (!dashEntry) return;
    if (hasBlockingPendingDashboardAction(dashEntry)) {
      return;
    }
    this.preferDashboardEntrySelection("session", dashEntry.id, this.dashboardState.focusedWorktreePath);
    if (this.openLiveTmuxWindowForEntry(dashEntry) !== "missing") {
      return;
    }
    if (dashEntry.remoteInstanceId) {
      void this.takeoverFromDashEntryWithFeedback(dashEntry);
      return;
    }
    if (dashEntry.status === "offline") {
      const offline = this.offlineSessions.find((s: any) => s.id === dashEntry.id);
      if (offline) {
        void this.resumeOfflineSessionWithFeedback(offline);
      }
      return;
    }
    const ptyIdx = this.sessions.findIndex((s: any) => s.id === dashEntry.id);
    if (ptyIdx >= 0) this.focusSession(ptyIdx);
  },

  commitDashboardQuickJump(this: any, digits?: string): boolean {
    const buffered = digits ?? this.dashboardState.quickJumpDigits;
    this.clearDashboardQuickJump();
    if (!buffered) return false;
    const target = resolveDashboardQuickJumpTarget(
      buildDashboardQuickJumpWorktrees({
        sessions: this.dashboardSessionsCache,
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
          sessions: this.dashboardSessionsCache,
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
    const key = event.name || event.char;
    const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");
    const hasWorktrees = this.dashboardState.hasWorktrees();

    if (hasWorktrees && this.dashboardState.quickJumpDigits && !(key >= "1" && key <= "9")) {
      this.commitDashboardQuickJump();
    }

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

    switch (key) {
      case "?":
        this.showHelp();
        return;
      case "c":
        this.showToolPicker();
        return;
      case "v":
        this.showServiceCreatePrompt();
        return;
      case "f": {
        const selected = this.getSelectedDashboardSessionForActions();
        if (selected && !selected.remoteInstancePid) {
          this.showToolPicker(selected.id);
        } else if (hasWorktrees && this.dashboardState.level === "worktrees") {
          this.showDashboardError("Select an agent to fork", [
            "Press Enter to step into a worktree, then select a session and press [f] to fork it.",
          ]);
        }
        return;
      }
      case "S":
        this.showOrchestrationRoutePicker("message");
        return;
      case "H":
        this.showOrchestrationRoutePicker("handoff");
        return;
      case "T":
        this.showOrchestrationRoutePicker("task");
        return;
      case "o": {
        const selected = this.getSelectedDashboardSessionForActions();
        if (selected && !selected.remoteInstancePid) {
          this.openRelevantThreadForSession(selected.id);
        }
        return;
      }
      case "R": {
        const selected = this.getSelectedDashboardSessionForActions();
        if (selected && !selected.remoteInstancePid) {
          if ((selected.threadWaitingOnMeCount ?? 0) > 0) {
            this.openRelevantThreadForSession(selected.id);
          } else {
            this.footerFlash = `Nothing waiting on you for ${selected.label ?? selected.command}`;
            this.footerFlashTicks = 3;
            this.renderDashboard();
          }
        }
        return;
      }
      case "q":
        this.exitDashboardClientOrProcess();
        return;
      case "w":
        this.showWorktreeCreatePrompt();
        return;
      case "W":
        this.showWorktreeList();
        return;
      case "g":
        this.showGraveyard();
        return;
      case "i":
        this.showNotifications();
        return;
      case "y":
        this.showWorkflow();
        return;
      case "p":
        this.showPlans();
        return;
      case "t":
        this.showThreads();
        return;
      case "a":
        this.showActivityDashboard();
        return;
      case "u":
        void this.activateNextAttentionEntry();
        return;
      case "x": {
        if (hasWorktrees && this.dashboardState.level === "worktrees" && this.dashboardState.focusedWorktreePath) {
          const focusedGroup = this.dashboardWorktreeGroupsCache.find(
            (group: any) => group.path === this.dashboardState.focusedWorktreePath,
          );
          if (
            focusedGroup?.removing ||
            focusedGroup?.pending ||
            this.pendingWorktreeRemovals?.has?.(focusedGroup.path)
          ) {
            this.footerFlash = `Already removing ${focusedGroup.name ?? focusedGroup.path.split("/").pop() ?? "worktree"}`;
            this.footerFlashTicks = 2;
            this.renderDashboard();
            return;
          }
          const wtName =
            this.dashboardState.focusedWorktreePath.split("/").pop() ?? this.dashboardState.focusedWorktreePath;
          this.worktreeRemoveConfirm = { path: this.dashboardState.focusedWorktreePath, name: wtName };
          this.renderWorktreeRemoveConfirm();
          return;
        }

        const selectedService = this.getSelectedDashboardServiceForActions();
        if (selectedService) {
          try {
            if (selectedService.status === "offline") {
              this.removeOfflineService(selectedService.id);
              this.footerFlash = `◆ Deleted service ${selectedService.label ?? selectedService.id}`;
            } else {
              this.stopService(selectedService.id);
              this.footerFlash = `◆ Stopped service ${selectedService.label ?? selectedService.id}`;
            }
            this.footerFlashTicks = 3;
            this.renderDashboard();
          } catch (error) {
            this.showDashboardError(
              selectedService.status === "offline" ? "Failed to delete service" : "Failed to stop service",
              [error instanceof Error ? error.message : String(error)],
            );
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

        const runtime = this.sessions.find((s: any) => s.id === selEntry.id);
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
          this.showMigratePicker();
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
        if (selEntry2 && !selEntry2.remoteInstancePid) {
          this.labelInputActive = true;
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
        case "p":
          if (totalCount > 1) {
            this.activeIndex = (this.activeIndex - 1 + totalCount) % totalCount;
            this.renderDashboard();
          }
          break;
        case "enter": {
          const ds = this.getDashboardSessions();
          const entry = ds[this.activeIndex];
          if (hasBlockingPendingDashboardAction(entry)) {
            return;
          }
          if (entry && this.openLiveTmuxWindowForEntry(entry) !== "missing") {
            return;
          }
          if (entry?.remoteInstanceId) {
            void this.takeoverFromDashEntryWithFeedback(entry);
            return;
          }
          if (entry?.status === "offline") {
            const offline = this.offlineSessions.find((s: any) => s.id === entry.id);
            if (offline) {
              void this.resumeOfflineSessionWithFeedback(offline);
            }
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
        case "k":
        case "p": {
          const curIdx = this.dashboardState.worktreeNavOrder.indexOf(this.dashboardState.focusedWorktreePath);
          this.dashboardState.focusedWorktreePath =
            this.dashboardState.worktreeNavOrder[
              (curIdx - 1 + this.dashboardState.worktreeNavOrder.length) % this.dashboardState.worktreeNavOrder.length
            ];
          this.renderDashboard();
          break;
        }
        case "enter":
        case "right":
        case "l":
          this.updateWorktreeSessions();
          if (this.dashboardState.worktreeEntries.length > 0) {
            this.dashboardState.level = "sessions";
            this.dashboardState.sessionIndex = 0;
            this.renderDashboard();
          }
          break;
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
        case "p":
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

  async activateDashboardEntry(this: any, entry: DashboardSession): Promise<void> {
    if (!entry) return;
    if (hasBlockingPendingDashboardAction(entry)) {
      return;
    }

    if (this.openLiveTmuxWindowForEntry(entry) !== "missing") {
      return;
    }

    if (entry.remoteInstanceId) {
      await this.takeoverFromDashEntryWithFeedback(entry);
      return;
    }

    if (entry.status === "offline") {
      const offline = this.offlineSessions.find((session: any) => session.id === entry.id);
      if (offline) {
        await this.resumeOfflineSessionWithFeedback(offline);
      }
      return;
    }

    const ptyIdx = this.sessions.findIndex((session: any) => session.id === entry.id);
    if (ptyIdx >= 0) {
      this.noteLastUsedItem(entry.id);
      this.focusSession(ptyIdx);
    }
  },

  handleServiceInputKey(this: any, data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    if (key === "escape") {
      this.serviceInputActive = false;
      this.renderDashboard();
      return;
    }

    if (key === "enter" || key === "return") {
      this.serviceInputActive = false;
      try {
        this.createService(this.serviceInputBuffer, this.dashboardState.focusedWorktreePath);
      } catch (error) {
        this.showDashboardError("Failed to create service", [error instanceof Error ? error.message : String(error)]);
        return;
      }
      this.renderDashboard();
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
    const key = event.name || event.char;

    if (key === "escape") {
      this.labelInputActive = false;
      this.labelInputTarget = null;
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }

    if (key === "enter" || key === "return") {
      this.labelInputActive = false;
      const label = this.labelInputBuffer.trim();
      const targetId = this.labelInputTarget;
      this.labelInputTarget = null;
      if (targetId) {
        void this.updateSessionLabel(targetId, label || undefined);
        return;
      }
      if (this.mode === "dashboard") this.renderDashboard();
      else this.focusSession(this.activeIndex);
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

  handleReviewRequest(this: any): void {
    const session = this.activeSession;
    if (!session) return;

    const role = this.sessionRoles.get(session.id) ?? "coder";
    let diff: string | undefined;
    try {
      diff = execSync("git diff HEAD", { encoding: "utf-8", timeout: 5000 }).slice(0, 5000) || undefined;
    } catch {}

    const reviewTask = requestReview(session.id, role, diff, `Review ${session.command} agent's recent work`);

    if (reviewTask) {
      this.footerFlash = `⧫ Review requested → ${reviewTask.assignee ?? "reviewer"}`;
      this.footerFlashTicks = 3;
    } else {
      this.footerFlash = "No reviewer role configured";
      this.footerFlashTicks = 3;
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
        await this.postToProjectService("/threads/send", {
          kind: "request",
          ...requestBody,
          body,
        });
        const count = target.sessionId ? 1 : (target.recipientIds?.length ?? 0);
        this.footerFlash = `Sent message to ${count} recipient${count === 1 ? "" : "s"}`;
      } else if (mode === "handoff") {
        await this.postToProjectService("/tasks/handoff", {
          ...requestBody,
          body,
        });
        this.footerFlash = `Sent handoff to ${target.label}`;
      } else {
        await this.postToProjectService("/tasks/assign", {
          ...requestBody,
          body,
        });
        this.footerFlash = `Assigned task to ${target.label}`;
      }
      this.footerFlashTicks = 3;
      this.orchestrationInputActive = false;
      this.orchestrationInputBuffer = "";
      this.orchestrationInputTarget = null;
      this.orchestrationInputMode = null;
    } catch (error) {
      this.orchestrationInputActive = false;
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
