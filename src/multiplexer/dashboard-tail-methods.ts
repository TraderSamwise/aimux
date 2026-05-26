import type { DashboardService, DashboardSession } from "../dashboard/index.js";
import type { Multiplexer, SessionState } from "./index.js";
import {
  buildPlanPreview as buildPlanPreviewImpl,
  handleGraveyardKey as handleGraveyardKeyImpl,
  handlePlansKey as handlePlansKeyImpl,
  loadPlanEntries as loadPlanEntriesImpl,
  openPlanInEditor as openPlanInEditorImpl,
  parsePlanFrontmatter as parsePlanFrontmatterImpl,
  renderGraveyard as renderGraveyardImpl,
  renderGraveyardDetailsForHost as renderGraveyardDetailsForHostImpl,
  renderPlanDetailsForHost as renderPlanDetailsForHostImpl,
  renderPlans as renderPlansImpl,
  resurrectGraveyardEntry as resurrectGraveyardEntryImpl,
  showGraveyard as showGraveyardImpl,
  showPlans as showPlansImpl,
} from "./archives.js";
import {
  confirmSwitcher as confirmSwitcherImpl,
  dismissHelp as dismissHelpImpl,
  dismissSwitcher as dismissSwitcherImpl,
  getSwitcherList as getSwitcherListImpl,
  handleHelpKey as handleHelpKeyImpl,
  handleMigratePickerKey as handleMigratePickerKeyImpl,
  handleSwitcherKey as handleSwitcherKeyImpl,
  redrawCurrentView as redrawCurrentViewImpl,
  renderHelp as renderHelpImpl,
  renderMigratePicker as renderMigratePickerImpl,
  renderSwitcher as renderSwitcherImpl,
  resetSwitcherTimeout as resetSwitcherTimeoutImpl,
  showHelp as showHelpImpl,
  showMigratePicker as showMigratePickerImpl,
  showSwitcher as showSwitcherImpl,
} from "./navigation.js";
import {
  basenameForHost,
  clearDashboardSubscreens as clearDashboardSubscreensImpl,
  composeSplitScreen as composeSplitScreenImpl,
  composeTwoPaneLines as composeTwoPaneLinesImpl,
  createDashboardServiceWithFeedback as createDashboardServiceWithFeedbackImpl,
  dashboardSessionActionDeps as dashboardSessionActionDepsImpl,
  graveyardSessionWithFeedback as graveyardSessionWithFeedbackImpl,
  migrateSessionWithFeedback as migrateSessionWithFeedbackImpl,
  removeDashboardServiceWithFeedback as removeDashboardServiceWithFeedbackImpl,
  renderSessionDetails as renderSessionDetailsImpl,
  resumeOfflineServiceWithFeedback as resumeOfflineServiceWithFeedbackImpl,
  resumeOfflineSessionWithFeedback as resumeOfflineSessionWithFeedbackImpl,
  runDashboardOperation as runDashboardOperationImpl,
  setPendingDashboardServiceAction as setPendingDashboardServiceActionImpl,
  setPendingDashboardSessionAction as setPendingDashboardSessionActionImpl,
  stopDashboardServiceWithFeedback as stopDashboardServiceWithFeedbackImpl,
  stopSessionToOfflineWithFeedback as stopSessionToOfflineWithFeedbackImpl,
  truncateAnsiForHost,
  truncatePlainForHost,
  waitForSessionStartForHost,
  wrapKeyValueForHost,
  wrapTextForHost,
} from "./dashboard-ops.js";
import type { PendingServiceActionKind, PendingSessionActionKind } from "../pending-actions.js";
import { findMainRepo, listWorktrees as listAllWorktrees } from "../worktree.js";
import { orderDashboardSessionsByVisualWorktree } from "../dashboard/session-registry.js";
import type { SessionRuntime } from "../session-runtime.js";
import { loadConfig } from "../config.js";
import type { SessionTeamMetadata } from "../team.js";
import {
  listTopologySessionStates,
  moveTopologySessionToGraveyard,
  upsertTopologySession,
  type RuntimeTopologySessionState,
} from "../runtime-core/topology-sessions.js";

type DashboardTailHost = {
  mode: "dashboard" | "project-service";
  dashboardSessionsCache: DashboardSession[];
  dashboardServicesCache: DashboardService[];
  dashboardWorktreeGroupsCache: Array<{ sessions: DashboardSession[] }>;
};

function isLiveTopologyStatus(status: RuntimeTopologySessionState["status"] | undefined): boolean {
  return status === "running" || status === "idle" || status === "starting";
}

function runtimeToTopologySessionState(host: Multiplexer, session: any): RuntimeTopologySessionState {
  return {
    id: session.id,
    tool: session.command,
    toolConfigKey: (host as any).sessionToolKeys?.get?.(session.id) ?? session.command,
    command: session.command,
    args: (host as any).sessionOriginalArgs?.get?.(session.id) ?? [],
    lifecycle: "offline",
    createdAt: session.startTime ? new Date(session.startTime).toISOString() : undefined,
    backendSessionId: session.backendSessionId,
    team: session.team,
    worktreePath: (host as any).sessionWorktreePaths?.get?.(session.id),
    label: (host as any).getSessionLabel?.(session.id),
    headline: (host as any).deriveHeadline?.(session.id),
  };
}

function cacheOfflineSession(host: Multiplexer, entry: RuntimeTopologySessionState): void {
  const cache = (host as any).offlineSessions;
  if (!Array.isArray(cache)) return;
  const offlineEntry = { ...entry, lifecycle: "offline" as const, status: "offline" as const };
  const existingIndex = cache.findIndex((session: any) => session.id === entry.id);
  if (existingIndex >= 0) {
    cache[existingIndex] = { ...cache[existingIndex], ...offlineEntry };
  } else {
    cache.push(offlineEntry);
  }
}

function removeOfflineSessionCache(host: Multiplexer, sessionId: string): void {
  if (!Array.isArray((host as any).offlineSessions)) return;
  (host as any).offlineSessions = (host as any).offlineSessions.filter((session: any) => session.id !== sessionId);
}

function findTopologySession(sessionId: string): RuntimeTopologySessionState | undefined {
  return listTopologySessionStates({ statuses: ["running", "idle", "starting", "offline", "graveyard"] }).find(
    (session) => session.id === sessionId,
  );
}

function refreshLifecycleViews(host: Multiplexer): void {
  (host as any).invalidateDesktopStateSnapshot?.();
  (host as any).writeStatuslineFile?.();
  if ((host as any).mode === "dashboard") {
    (host as any).renderCurrentDashboardView?.();
  }
  (host as any).updateContextWatcherSessions?.();
}

export type DashboardTailMethods = {
  forkAgent(
    this: Multiplexer,
    opts: {
      sourceSessionId: string;
      targetToolConfigKey: string;
      targetSessionId?: string;
      instruction?: string;
      targetWorktreePath?: string;
      open?: boolean;
      extraArgs?: string[];
    },
  ): Promise<{ sessionId: string; threadId: string }>;
  spawnAgent(
    this: Multiplexer,
    opts: {
      toolConfigKey: string;
      targetSessionId?: string;
      targetWorktreePath?: string;
      open?: boolean;
      extraArgs?: string[];
    },
  ): Promise<{ sessionId: string }>;
  createTeammateAgent(
    this: Multiplexer,
    opts: {
      parentSessionId: string;
      role?: string;
      label?: string;
      toolConfigKey?: string;
      targetSessionId?: string;
      targetWorktreePath?: string;
      open?: boolean;
      extraArgs?: string[];
      order?: number;
    },
  ): Promise<{ sessionId: string; parentSessionId: string; teamId: string; role?: string; label?: string }>;
  renameAgent(this: Multiplexer, sessionId: string, label?: string): Promise<{ sessionId: string; label?: string }>;
  stopAgent(this: Multiplexer, sessionId: string): Promise<{ sessionId: string; status: "offline" }>;
  sendAgentToGraveyard(
    this: Multiplexer,
    sessionId: string,
  ): Promise<{
    sessionId: string;
    status: "graveyard";
    previousStatus: "running" | "offline";
  }>;
  migrateAgentSession(
    this: Multiplexer,
    sessionId: string,
    targetWorktreePath: string,
  ): Promise<{ sessionId: string; worktreePath?: string }>;
  showGraveyard(this: Multiplexer): void;
  renderGraveyard(this: Multiplexer): void;
  handleGraveyardKey(this: Multiplexer, data: Buffer): void;
  resurrectGraveyardEntry(this: Multiplexer, idx: number): void;
  showPlans(this: Multiplexer): void;
  loadPlanEntries(this: Multiplexer): void;
  parsePlanFrontmatter(this: Multiplexer, content: string): Record<string, string>;
  renderPlans(this: Multiplexer): void;
  buildPlanPreview(this: Multiplexer, content: string, width: number, maxLines: number): string[];
  renderPlanDetails(this: Multiplexer, width: number, height: number): string[];
  renderGraveyardDetails(this: Multiplexer, width: number, height: number): string[];
  handlePlansKey(this: Multiplexer, data: Buffer): void;
  openPlanInEditor(this: Multiplexer, path: string): void;
  getSwitcherList(this: Multiplexer): SessionRuntime[];
  showSwitcher(this: Multiplexer): void;
  resetSwitcherTimeout(this: Multiplexer): void;
  confirmSwitcher(this: Multiplexer): void;
  dismissSwitcher(this: Multiplexer): void;
  redrawCurrentView(this: Multiplexer): void;
  showHelp(this: Multiplexer): void;
  dismissHelp(this: Multiplexer): void;
  renderHelp(this: Multiplexer): void;
  handleHelpKey(this: Multiplexer, data: Buffer): void;
  renderSwitcher(this: Multiplexer): void;
  handleSwitcherKey(this: Multiplexer, data: Buffer): void;
  showMigratePicker(this: Multiplexer, sessionId?: string): void;
  renderMigratePicker(this: Multiplexer): void;
  runDashboardOperation<T>(
    this: Multiplexer,
    title: string,
    lines: string[],
    work: () => Promise<T> | T,
    errorTitle?: string,
  ): Promise<T | undefined>;
  setPendingDashboardSessionAction(
    this: Multiplexer,
    sessionId: string,
    kind: PendingSessionActionKind | null,
    opts?: { sessionSeed?: DashboardSession },
  ): void;
  setPendingDashboardServiceAction(
    this: Multiplexer,
    serviceId: string,
    kind: PendingServiceActionKind | null,
    opts?: { serviceSeed?: DashboardService },
  ): void;
  stopSessionToOfflineWithFeedback(this: Multiplexer, session: SessionRuntime): Promise<void>;
  clearDashboardSubscreens(this: Multiplexer): void;
  renderSessionDetails(
    this: Multiplexer,
    session: DashboardSession | undefined,
    width: number,
    height: number,
  ): string[];
  composeSplitScreen(
    this: Multiplexer,
    leftLines: string[],
    rightLines: string[],
    cols: number,
    viewportHeight: number,
    focusLine: number,
    twoPane: boolean,
  ): string[];
  composeTwoPaneLines(this: Multiplexer, left: string[], right: string[], cols: number): string[];
  wrapKeyValue(this: Multiplexer, key: string, value: string, width: number): string[];
  wrapText(this: Multiplexer, text: string, width: number): string[];
  truncatePlain(this: Multiplexer, text: string, max: number): string;
  truncateAnsi(this: Multiplexer, text: string, max: number): string;
  basename(this: Multiplexer, value: string): string;
  listAllWorktrees(this: Multiplexer): Array<{ name: string; branch: string; path: string; isBare: boolean }>;
  graveyardSessionWithFeedback(this: Multiplexer, sessionId: string, hasWorktrees: boolean): Promise<void>;
  resumeOfflineServiceWithFeedback(this: Multiplexer, service: Pick<DashboardService, "id" | "label">): Promise<void>;
  createDashboardServiceWithFeedback(this: Multiplexer, commandLine: string, worktreePath?: string): Promise<void>;
  stopDashboardServiceWithFeedback(this: Multiplexer, service: Pick<DashboardService, "id" | "label">): Promise<void>;
  removeDashboardServiceWithFeedback(this: Multiplexer, service: Pick<DashboardService, "id" | "label">): Promise<void>;
  resumeOfflineSessionWithFeedback(this: Multiplexer, session: SessionState): Promise<void>;
  waitForSessionStart(this: Multiplexer, sessionId: string, timeoutMs?: number): Promise<boolean>;
  dashboardSessionActionDeps(this: Multiplexer): ReturnType<typeof dashboardSessionActionDepsImpl>;
  migrateSessionWithFeedback(
    this: Multiplexer,
    session: SessionRuntime,
    targetPath: string,
    targetName: string,
  ): Promise<void>;
  handleMigratePickerKey(this: Multiplexer, data: Buffer): void;
  getDashboardSessions(this: Multiplexer): DashboardSession[];
  getDashboardServices(this: Multiplexer): DashboardService[];
  getDashboardSessionsInVisualOrder(this: Multiplexer): DashboardSession[];
};

export const dashboardTailMethods: DashboardTailMethods = {
  async forkAgent(opts) {
    const result = await (this as any).forkSessionFromSource(
      opts.sourceSessionId,
      opts.targetToolConfigKey,
      opts.targetSessionId,
      opts.instruction,
      opts.targetWorktreePath,
      opts.extraArgs ?? [],
    );
    if (!result) {
      throw new Error(`Unable to fork agent "${opts.sourceSessionId}"`);
    }
    if (opts.open) {
      this.openLiveTmuxWindowForEntry({ id: result.sessionId });
    }
    return { sessionId: result.sessionId, threadId: result.threadId };
  },
  async spawnAgent(opts) {
    const config = loadConfig();
    const tool = config.tools[opts.toolConfigKey];
    if (!tool) {
      throw new Error(`Unknown tool config: ${opts.toolConfigKey}`);
    }
    const sessionId = opts.targetSessionId ?? (this as any).generateDashboardSessionId?.(tool.command);
    const transport = this.createSession(
      tool.command,
      [...tool.args, ...(opts.extraArgs ?? [])],
      tool.preambleFlag,
      opts.toolConfigKey,
      undefined,
      tool.sessionIdFlag,
      opts.targetWorktreePath,
      undefined,
      sessionId,
      !opts.open,
    );
    if (opts.open) {
      this.openLiveTmuxWindowForEntry({ id: transport.id });
    }
    return { sessionId: transport.id };
  },
  async createTeammateAgent(opts) {
    const config = loadConfig();
    const toolConfigKey = opts.toolConfigKey ?? config.defaultTool;
    const tool = config.tools[toolConfigKey];
    if (!tool) {
      throw new Error(`Unknown tool config: ${toolConfigKey}`);
    }
    const sessionId = opts.targetSessionId ?? (this as any).generateDashboardSessionId?.(tool.command);
    const team: SessionTeamMetadata = {
      teamId: `team-${opts.parentSessionId}`,
      parentSessionId: opts.parentSessionId,
      role: opts.role,
      label: opts.label,
      order: typeof opts.order === "number" ? opts.order : undefined,
    };
    const transport = this.createSession(
      tool.command,
      [...tool.args, ...(opts.extraArgs ?? [])],
      tool.preambleFlag,
      toolConfigKey,
      undefined,
      tool.sessionIdFlag,
      opts.targetWorktreePath,
      undefined,
      sessionId,
      !opts.open,
      false,
      team,
    );
    if (opts.label) {
      this.applySessionLabel(transport.id, opts.label);
    }
    if (opts.open) {
      this.openLiveTmuxWindowForEntry({ id: transport.id });
    }
    return {
      sessionId: transport.id,
      parentSessionId: opts.parentSessionId,
      teamId: team.teamId,
      role: opts.role,
      label: opts.label,
    };
  },
  async renameAgent(sessionId, label) {
    await this.updateSessionLabel(sessionId, label);
    return { sessionId, label: label?.trim() || undefined };
  },
  async stopAgent(sessionId) {
    const runtime = (this as any).sessions?.find?.((session: any) => session.id === sessionId);
    if (runtime) {
      if ((this as any).stoppingSessionIds?.has?.(sessionId)) {
        return { sessionId, status: "offline" };
      }
      const offlineEntry = runtimeToTopologySessionState(this, runtime);
      upsertTopologySession(offlineEntry, "offline");
      cacheOfflineSession(this, offlineEntry);
      (this as any).stoppingSessionIds?.add?.(sessionId);
      (this as any).startedInDashboard = true;
      runtime.kill();
      refreshLifecycleViews(this);
      (this as any).debug?.(`stopped session ${sessionId} -> offline`, "session");
      return { sessionId, status: "offline" };
    }
    const existing = findTopologySession(sessionId);
    if (existing?.status === "offline") {
      cacheOfflineSession(this, existing);
      return { sessionId, status: "offline" };
    }
    if (existing && isLiveTopologyStatus(existing.status)) {
      upsertTopologySession({ ...existing, lifecycle: "offline" }, "offline");
      cacheOfflineSession(this, { ...existing, lifecycle: "offline", status: "offline" });
      refreshLifecycleViews(this);
      return { sessionId, status: "offline" };
    }
    if (existing?.status === "graveyard") {
      throw new Error(`Session "${sessionId}" is already in graveyard`);
    }
    throw new Error(`Unknown session "${sessionId}"`);
  },
  async sendAgentToGraveyard(sessionId) {
    const runtime = (this as any).sessions?.find?.((session: any) => session.id === sessionId);
    const existing = findTopologySession(sessionId);
    const previousStatus: "running" | "offline" =
      runtime || isLiveTopologyStatus(existing?.status) ? "running" : "offline";
    if (existing?.status === "graveyard") {
      return { sessionId, status: "graveyard", previousStatus };
    }
    if (runtime && !existing) {
      upsertTopologySession(runtimeToTopologySessionState(this, runtime), "running");
    } else if (!runtime && !existing) {
      throw new Error(`Unknown session "${sessionId}"`);
    }
    const moved = moveTopologySessionToGraveyard(sessionId);
    if (!moved) {
      throw new Error(`Unable to graveyard session "${sessionId}"`);
    }
    removeOfflineSessionCache(this, sessionId);
    if (runtime) {
      (this as any).graveyardAfterStopSessionIds?.add?.(sessionId);
      (this as any).stoppingSessionIds?.add?.(sessionId);
      runtime.kill();
    }
    refreshLifecycleViews(this);
    (this as any).debug?.(`graveyarded session ${sessionId}`, "session");
    return { sessionId, status: "graveyard", previousStatus };
  },
  async migrateAgentSession(sessionId, targetWorktreePath) {
    await this.migrateAgent(sessionId, targetWorktreePath);
    return { sessionId, worktreePath: targetWorktreePath };
  },
  showGraveyard() {
    showGraveyardImpl(this);
  },
  renderGraveyard() {
    renderGraveyardImpl(this);
  },
  handleGraveyardKey(data) {
    handleGraveyardKeyImpl(this, data);
  },
  resurrectGraveyardEntry(idx) {
    resurrectGraveyardEntryImpl(this, idx);
  },
  showPlans() {
    showPlansImpl(this);
  },
  loadPlanEntries() {
    loadPlanEntriesImpl(this);
  },
  parsePlanFrontmatter(content) {
    return parsePlanFrontmatterImpl(content);
  },
  renderPlans() {
    renderPlansImpl(this);
  },
  buildPlanPreview(content, width, maxLines) {
    return buildPlanPreviewImpl(content, width, maxLines);
  },
  renderPlanDetails(width, height) {
    return renderPlanDetailsForHostImpl(this, width, height);
  },
  renderGraveyardDetails(width, height) {
    return renderGraveyardDetailsForHostImpl(this, width, height);
  },
  handlePlansKey(data) {
    handlePlansKeyImpl(this, data);
  },
  openPlanInEditor(path) {
    openPlanInEditorImpl(this, path);
  },
  getSwitcherList() {
    return getSwitcherListImpl(this);
  },
  showSwitcher() {
    showSwitcherImpl(this);
  },
  resetSwitcherTimeout() {
    resetSwitcherTimeoutImpl(this);
  },
  confirmSwitcher() {
    confirmSwitcherImpl(this);
  },
  dismissSwitcher() {
    dismissSwitcherImpl(this);
  },
  redrawCurrentView() {
    redrawCurrentViewImpl(this);
  },
  showHelp() {
    showHelpImpl(this);
  },
  dismissHelp() {
    dismissHelpImpl(this);
  },
  renderHelp() {
    renderHelpImpl(this);
  },
  handleHelpKey(data) {
    handleHelpKeyImpl(this, data);
  },
  renderSwitcher() {
    renderSwitcherImpl(this);
  },
  handleSwitcherKey(data) {
    handleSwitcherKeyImpl(this, data);
  },
  showMigratePicker(sessionId?: string) {
    showMigratePickerImpl(this, sessionId);
  },
  renderMigratePicker() {
    renderMigratePickerImpl(this);
  },
  async runDashboardOperation(title, lines, work, errorTitle = title) {
    return runDashboardOperationImpl(this, title, lines, work, errorTitle);
  },
  setPendingDashboardSessionAction(sessionId, kind, opts) {
    setPendingDashboardSessionActionImpl(this, sessionId, kind, opts);
  },
  setPendingDashboardServiceAction(serviceId, kind, opts) {
    setPendingDashboardServiceActionImpl(this, serviceId, kind, opts);
  },
  async stopSessionToOfflineWithFeedback(session) {
    await stopSessionToOfflineWithFeedbackImpl(this, session);
  },
  clearDashboardSubscreens() {
    clearDashboardSubscreensImpl(this);
  },
  renderSessionDetails(session, width, height) {
    return renderSessionDetailsImpl(this, session, width, height);
  },
  composeSplitScreen(leftLines, rightLines, cols, viewportHeight, focusLine, twoPane) {
    return composeSplitScreenImpl(this, leftLines, rightLines, cols, viewportHeight, focusLine, twoPane);
  },
  composeTwoPaneLines(left, right, cols) {
    return composeTwoPaneLinesImpl(left, right, cols);
  },
  wrapKeyValue(key, value, width) {
    return wrapKeyValueForHost(key, value, width);
  },
  wrapText(text, width) {
    return wrapTextForHost(text, width);
  },
  truncatePlain(text, max) {
    return truncatePlainForHost(text, max);
  },
  truncateAnsi(text, max) {
    return truncateAnsiForHost(text, max);
  },
  basename(value) {
    return basenameForHost(value);
  },
  listAllWorktrees() {
    return listAllWorktrees();
  },
  async graveyardSessionWithFeedback(sessionId, hasWorktrees) {
    await graveyardSessionWithFeedbackImpl(this, sessionId, hasWorktrees);
  },
  async resumeOfflineServiceWithFeedback(service) {
    await resumeOfflineServiceWithFeedbackImpl(this, service);
  },
  async createDashboardServiceWithFeedback(commandLine, worktreePath) {
    await createDashboardServiceWithFeedbackImpl(this, commandLine, worktreePath);
  },
  async stopDashboardServiceWithFeedback(service) {
    await stopDashboardServiceWithFeedbackImpl(this, service);
  },
  async removeDashboardServiceWithFeedback(service) {
    await removeDashboardServiceWithFeedbackImpl(this, service);
  },
  async resumeOfflineSessionWithFeedback(session) {
    await resumeOfflineSessionWithFeedbackImpl(this, session);
  },
  async waitForSessionStart(sessionId, timeoutMs = 8000) {
    return waitForSessionStartForHost(this, sessionId, timeoutMs);
  },
  dashboardSessionActionDeps() {
    return dashboardSessionActionDepsImpl(this);
  },
  async migrateSessionWithFeedback(session, targetPath, targetName) {
    await migrateSessionWithFeedbackImpl(this, session, targetPath, targetName);
  },
  handleMigratePickerKey(data) {
    handleMigratePickerKeyImpl(this, data);
  },
  getDashboardSessions() {
    const mux = this as unknown as DashboardTailHost;
    return mux.mode === "dashboard" ? mux.dashboardSessionsCache : this.computeDashboardSessions();
  },
  getDashboardServices() {
    const mux = this as unknown as DashboardTailHost;
    return mux.mode === "dashboard" ? mux.dashboardServicesCache : this.computeDashboardServices();
  },
  getDashboardSessionsInVisualOrder() {
    const mux = this as unknown as DashboardTailHost;
    const allDash = this.getDashboardSessions();
    if (mux.mode === "dashboard") {
      const mainSessions = allDash.filter((session) => !session.worktreePath);
      const ordered = [...mainSessions];
      const seen = new Set(mainSessions.map((session) => session.id));
      for (const group of mux.dashboardWorktreeGroupsCache) {
        for (const session of group.sessions) {
          if (seen.has(session.id)) continue;
          ordered.push(session);
          seen.add(session.id);
        }
      }
      for (const session of allDash) {
        if (!seen.has(session.id)) ordered.push(session);
      }
      return ordered;
    }
    let mainRepoPath: string | undefined;
    try {
      mainRepoPath = findMainRepo();
    } catch {}
    let worktreePaths: Array<string | undefined> = [];
    try {
      const worktrees = listAllWorktrees();
      worktreePaths = [
        undefined,
        ...worktrees.filter((wt) => !wt.isBare && wt.path !== mainRepoPath).map((wt) => wt.path),
      ];
    } catch {
      return allDash;
    }
    return orderDashboardSessionsByVisualWorktree(allDash, worktreePaths, mainRepoPath);
  },
};
