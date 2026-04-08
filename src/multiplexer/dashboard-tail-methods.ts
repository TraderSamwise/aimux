import { debug } from "../debug.js";
import type { DashboardService, DashboardSession } from "../dashboard/index.js";
import type { Multiplexer, SessionState } from "./index.js";
import {
  forkAgent as forkAgentImpl,
  migrateAgentSession as migrateAgentSessionImpl,
  renameAgent as renameAgentImpl,
  sendAgentToGraveyard as sendAgentToGraveyardImpl,
  spawnAgent as spawnAgentImpl,
  stopAgent as stopAgentImpl,
} from "./session-actions.js";
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
  dashboardSessionActionDeps as dashboardSessionActionDepsImpl,
  graveyardSessionWithFeedback as graveyardSessionWithFeedbackImpl,
  migrateSessionWithFeedback as migrateSessionWithFeedbackImpl,
  renderSessionDetails as renderSessionDetailsImpl,
  resumeOfflineSessionWithFeedback as resumeOfflineSessionWithFeedbackImpl,
  runDashboardOperation as runDashboardOperationImpl,
  setPendingDashboardSessionAction as setPendingDashboardSessionActionImpl,
  stopSessionToOfflineWithFeedback as stopSessionToOfflineWithFeedbackImpl,
  takeoverFromDashEntryWithFeedback as takeoverFromDashEntryWithFeedbackImpl,
  truncateAnsiForHost,
  truncatePlainForHost,
  waitForSessionStartForHost,
  wrapKeyValueForHost,
  wrapTextForHost,
} from "./dashboard-ops.js";
import type { PendingDashboardActionKind } from "../dashboard/pending-actions.js";
import { findMainRepo, listWorktrees as listAllWorktrees } from "../worktree.js";
import { orderDashboardSessionsByVisualWorktree } from "../dashboard/session-registry.js";
import { loadConfig } from "../config.js";
import type { SessionRuntime } from "../session-runtime.js";

type DashboardTailHost = {
  mode: "dashboard" | "project-service";
  dashboardSessionsCache: DashboardSession[];
  dashboardServicesCache: DashboardService[];
  dashboardWorktreeGroupsCache: Array<{ sessions: DashboardSession[] }>;
  instanceDirectory: {
    claimSession(sessionId: string, fromInstanceId: string, cwd: string): Promise<{ worktreePath?: string } | null>;
  };
  sessionBootstrap: {
    canResumeWithBackendSessionId(toolCfg: { resumeArgs?: string[] }, backendSessionId?: string): boolean;
    composeToolArgs(toolCfg: { args: string[] }, args: string[]): string[];
  };
};

export type DashboardTailMethods = {
  forkAgent(
    this: Multiplexer,
    opts: {
      sourceSessionId: string;
      targetToolConfigKey: string;
      instruction?: string;
      targetWorktreePath?: string;
      open?: boolean;
    },
  ): Promise<{ sessionId: string; threadId: string }>;
  spawnAgent(
    this: Multiplexer,
    opts: {
      toolConfigKey: string;
      targetWorktreePath?: string;
      open?: boolean;
    },
  ): Promise<{ sessionId: string }>;
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
  showMigratePicker(this: Multiplexer): void;
  renderMigratePicker(this: Multiplexer): void;
  runDashboardOperation<T>(
    this: Multiplexer,
    title: string,
    lines: string[],
    work: () => Promise<T> | T,
    errorTitle?: string,
  ): Promise<T | undefined>;
  setPendingDashboardSessionAction(this: Multiplexer, sessionId: string, kind: PendingDashboardActionKind | null): void;
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
  resumeOfflineSessionWithFeedback(this: Multiplexer, session: SessionState): Promise<void>;
  waitForSessionStart(this: Multiplexer, sessionId: string, timeoutMs?: number): Promise<boolean>;
  dashboardSessionActionDeps(this: Multiplexer): ReturnType<typeof dashboardSessionActionDepsImpl>;
  takeoverFromDashEntryWithFeedback(this: Multiplexer, entry: DashboardSession): Promise<void>;
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
  takeoverSessionFromDashEntry(this: Multiplexer, entry: DashboardSession): Promise<void>;
  takeoverSession(
    this: Multiplexer,
    target: {
      id: string;
      tool: string;
      backendSessionId: string;
      fromInstanceId: string;
    },
  ): Promise<void>;
};

export const dashboardTailMethods: DashboardTailMethods = {
  async forkAgent(opts) {
    return forkAgentImpl(this, opts);
  },
  async spawnAgent(opts) {
    return spawnAgentImpl(this, opts);
  },
  async renameAgent(sessionId, label) {
    return renameAgentImpl(this, sessionId, label);
  },
  async stopAgent(sessionId) {
    return stopAgentImpl(this, sessionId);
  },
  async sendAgentToGraveyard(sessionId) {
    return sendAgentToGraveyardImpl(this, sessionId);
  },
  async migrateAgentSession(sessionId, targetWorktreePath) {
    return migrateAgentSessionImpl(this, sessionId, targetWorktreePath);
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
  showMigratePicker() {
    showMigratePickerImpl(this);
  },
  renderMigratePicker() {
    renderMigratePickerImpl(this);
  },
  async runDashboardOperation(title, lines, work, errorTitle = title) {
    return runDashboardOperationImpl(this, title, lines, work, errorTitle);
  },
  setPendingDashboardSessionAction(sessionId, kind) {
    setPendingDashboardSessionActionImpl(this, sessionId, kind);
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
  async resumeOfflineSessionWithFeedback(session) {
    await resumeOfflineSessionWithFeedbackImpl(this, session);
  },
  async waitForSessionStart(sessionId, timeoutMs = 8000) {
    return waitForSessionStartForHost(this, sessionId, timeoutMs);
  },
  dashboardSessionActionDeps() {
    return dashboardSessionActionDepsImpl(this);
  },
  async takeoverFromDashEntryWithFeedback(entry) {
    await takeoverFromDashEntryWithFeedbackImpl(this, entry);
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
  async takeoverSessionFromDashEntry(entry) {
    if (!entry.remoteInstanceId || !entry.remoteBackendSessionId) return;
    await this.takeoverSession({
      id: entry.id,
      tool: entry.command,
      backendSessionId: entry.remoteBackendSessionId,
      fromInstanceId: entry.remoteInstanceId,
    });
  },
  async takeoverSession(target) {
    const mux = this as unknown as DashboardTailHost;
    const claimed = await mux.instanceDirectory.claimSession(target.id, target.fromInstanceId, process.cwd());
    if (!claimed) {
      debug(`takeover: session ${target.id} not found in instance ${target.fromInstanceId}`, "instance");
      return;
    }

    const config = loadConfig();
    const toolEntry = Object.entries(config.tools).find(([, t]) => t.command === target.tool);
    const toolCfg = toolEntry?.[1];
    const toolConfigKey = toolEntry?.[0];

    if (!toolCfg?.resumeArgs) {
      debug(`takeover: no resumeArgs configured for tool ${target.tool}`, "instance");
      return;
    }
    if (!mux.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, target.backendSessionId)) {
      debug(`takeover: tool ${target.tool} does not support backendSessionId resume`, "instance");
      return;
    }

    const resumeArgs = toolCfg.resumeArgs.map((a: string) => a.replace("{sessionId}", target.backendSessionId));
    const args = mux.sessionBootstrap.composeToolArgs(toolCfg, resumeArgs);

    debug(
      `taking over session ${target.id} (backend=${target.backendSessionId}) from instance ${target.fromInstanceId}`,
      "instance",
    );
    this.createSession(
      target.tool,
      args,
      toolCfg.preambleFlag,
      toolConfigKey,
      undefined,
      undefined,
      claimed.worktreePath,
      target.backendSessionId,
    );

    this.renderDashboard();
  },
};
