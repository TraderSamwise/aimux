import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync, spawn, spawnSync } from "node:child_process";
import { HotkeyHandler, type HotkeyAction } from "./hotkeys.js";
import {
  Dashboard,
  type DashboardService,
  type DashboardSession,
  type DashboardWorktreeEntry,
  type WorktreeGroup,
} from "./dashboard.js";
import { DashboardState, type DashboardScreen } from "./dashboard-state.js";
import { captureGitContext, ContextWatcher, buildContextPreamble } from "./context/context-bridge.js";
import { readHistory } from "./context/history.js";
import { parseKeys } from "./key-parser.js";
import { loadConfig, initProject } from "./config.js";
import {
  getProjectStateDir,
  getGraveyardPath,
  getStatePath,
  getStatusDir,
  getAimuxDirFor,
  getLocalAimuxDir,
  getPlansDir,
} from "./paths.js";
import { debug, closeDebug } from "./debug.js";
import { createWorktree, findMainRepo, listWorktrees as listAllWorktrees } from "./worktree.js";
import { type InstanceSessionRef } from "./instance-registry.js";
import { TaskDispatcher, requestReview } from "./task-dispatcher.js";
import { loadTeamConfig } from "./team.js";
import { TerminalHost } from "./terminal-host.js";
import { SessionRuntime, type SessionRuntimeEvent, type SessionTransport } from "./session-runtime.js";
import { buildDashboardSessions, orderDashboardSessionsByVisualWorktree } from "./dashboard-session-registry.js";
import { AgentTracker } from "./agent-tracker.js";
import { InstanceDirectory } from "./instance-directory.js";
import { loadLastUsedState, markLastUsed } from "./last-used.js";
import { TmuxRuntimeManager, type TmuxTarget, type TmuxWindowMetadata } from "./tmux-runtime-manager.js";
import { isDashboardWindowName } from "./tmux-runtime-manager.js";
import { TmuxSessionTransport } from "./tmux-session-transport.js";
import { MetadataServer } from "./metadata-server.js";
import {
  loadMetadataState,
  removeMetadataEndpoint,
  resolveProjectServiceEndpoint,
  updateSessionMetadata,
} from "./metadata-store.js";
import { PluginRuntime } from "./plugin-runtime.js";
import { SessionBootstrapService } from "./session-bootstrap.js";
import { ensureDaemonRunning, ensureProjectService, loadDaemonInfo } from "./daemon.js";
import {
  appendMessage,
  createThread,
  listThreadSummaries,
  markMessageDelivered,
  markThreadSeen,
  type MessageKind,
  type OrchestrationThread,
  readMessages,
  setThreadStatus,
  type ThreadStatus,
  updateThread,
} from "./threads.js";
import { sendDirectMessage, sendThreadMessage } from "./orchestration.js";
import {
  acceptHandoff,
  approveReview,
  acceptTask,
  assignTask,
  blockTask,
  completeHandoff,
  completeTask,
  reopenTask,
  requestTaskChanges,
  sendHandoff,
} from "./orchestration-actions.js";
import { OrchestrationDispatcher } from "./orchestration-dispatcher.js";
import { resolveOrchestrationRecipients } from "./orchestration-routing.js";
import { parseAgentOutput, type ParsedAgentOutput } from "./agent-output-parser.js";
import { serializeAgentInput, type AgentInputPart } from "./agent-message-parts.js";
import { resolveAttachmentPath } from "./attachment-store.js";
import { appendSessionMessage, readSessionMessages } from "./session-message-history.js";
import { ProjectEventBus, type AlertKind } from "./project-events.js";
import { deriveSessionSemantics } from "./session-semantics.js";
import { injectClaudeHookArgs } from "./claude-hooks.js";
import { wrapCommandWithShellIntegration, wrapInteractiveShellWithIntegration } from "./shell-hooks.js";
import { navigationUrgencyScore } from "./fast-control.js";
import { requestJson } from "./http-client.js";
import { openDashboardTarget } from "./dashboard-targets.js";
import {
  clearNotifications,
  listNotifications,
  markNotificationsRead,
  type NotificationRecord,
} from "./notifications.js";
import { updateNotificationContext } from "./notification-context.js";
import {
  buildThreadEntries,
  buildWorkflowEntries,
  describeWorkflowNextAction,
  filterWorkflowEntries,
  type ThreadEntry,
  type WorkflowEntry,
  type WorkflowFilter,
} from "./workflow.js";
import {
  renderActivityScreen,
  renderGraveyardDetails,
  renderGraveyardScreen,
  renderPlanDetails,
  renderPlansScreen,
  renderThreadDetails,
  renderThreadsScreen,
  renderWorkflowDetails,
  renderWorkflowScreen,
} from "./tui/screens/subscreen-renderers.js";
import {
  renderDashboardBusyOverlay,
  renderDashboardErrorOverlay,
  renderHelpOverlay,
  renderLabelInputOverlay,
  renderMigratePickerOverlay,
  renderNotificationPanel,
  renderServiceInputOverlay,
  renderSwitcherOverlay,
} from "./tui/screens/overlay-renderers.js";
import { composeTwoPane, stripAnsi, truncateAnsi, truncatePlain, wrapKeyValue, wrapText } from "./tui/render/text.js";
import { loadStatusline, renderTmuxStatuslineFromData } from "./tmux-statusline.js";
import { DashboardUiStateStore } from "./dashboard-ui-state-store.js";
import { DashboardPendingActions, type PendingDashboardActionKind } from "./dashboard-pending-actions.js";
import {
  DashboardFeedbackController,
  type DashboardBusyState,
  type DashboardErrorState,
} from "./dashboard-feedback.js";
import { MultiplexerRuntimeSync } from "./multiplexer-runtime-sync.js";
import { openManagedServiceWindow, openManagedSessionWindow, selectLinkedOrOpenTarget } from "./tmux-window-open.js";
import {
  beginWorktreeRemoval as beginWorktreeRemovalImpl,
  finishWorktreeRemoval as finishWorktreeRemovalImpl,
  handleWorktreeInputKey as handleWorktreeInputKeyImpl,
  handleWorktreeListKey as handleWorktreeListKeyImpl,
  handleWorktreeRemoveConfirmKey as handleWorktreeRemoveConfirmKeyImpl,
  renderWorktreeInput as renderWorktreeInputImpl,
  renderWorktreeList as renderWorktreeListImpl,
  renderWorktreeRemoveConfirm as renderWorktreeRemoveConfirmImpl,
  showWorktreeCreatePrompt as showWorktreeCreatePromptImpl,
  showWorktreeList as showWorktreeListImpl,
} from "./multiplexer-worktrees.js";
import {
  closeNotificationPanel as closeNotificationPanelImpl,
  handleNotificationPanelKey as handleNotificationPanelKeyImpl,
  showNotificationPanel as showNotificationPanelImpl,
} from "./multiplexer-notifications.js";
import {
  createService as createServiceImpl,
  removeOfflineService as removeOfflineServiceImpl,
  resumeOfflineService as resumeOfflineServiceImpl,
  resumeOfflineServiceById as resumeOfflineServiceByIdImpl,
  serviceLabelForCommand as serviceLabelForCommandImpl,
  stopService as stopServiceImpl,
} from "./multiplexer-services.js";
import {
  handleToolPickerKey as handleToolPickerKeyImpl,
  isToolAvailable,
  renderToolPicker as renderToolPickerImpl,
  runSelectedTool as runSelectedToolImpl,
  showToolPicker as showToolPickerImpl,
} from "./multiplexer-tool-picker.js";
import {
  forkAgent as forkAgentImpl,
  migrateAgentSession as migrateAgentSessionImpl,
  renameAgent as renameAgentImpl,
  sendAgentToGraveyard as sendAgentToGraveyardImpl,
  spawnAgent as spawnAgentImpl,
  stopAgent as stopAgentImpl,
} from "./multiplexer-session-actions.js";
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
} from "./multiplexer-archives.js";
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
} from "./multiplexer-navigation.js";
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
} from "./multiplexer-dashboard-ops.js";
import {
  graveyardSessionWithFeedback as runGraveyardSessionWithFeedback,
  resumeOfflineSessionWithFeedback as runResumeOfflineSessionWithFeedback,
  stopSessionToOfflineWithFeedback as runStopSessionToOfflineWithFeedback,
  waitForSessionExit,
  waitForSessionStart,
} from "./dashboard-session-actions.js";
import {
  applyDashboardModel as applyDashboardModelImpl,
  buildDashboardWorktreeGroups as buildDashboardWorktreeGroupsImpl,
  buildDesktopStateSnapshot as buildDesktopStateSnapshotImpl,
  computeDashboardServices as computeDashboardServicesImpl,
  computeDashboardSessions as computeDashboardSessionsImpl,
  invalidateDesktopStateSnapshot as invalidateDesktopStateSnapshotImpl,
  readTmuxProcessInfo as readTmuxProcessInfoImpl,
  refreshDashboardModelFromService as refreshDashboardModelFromServiceImpl,
  refreshDesktopStateSnapshot as refreshDesktopStateSnapshotImpl,
  refreshLocalDashboardModel as refreshLocalDashboardModelImpl,
  startProjectServices as startProjectServicesImpl,
  stopProjectServices as stopProjectServicesImpl,
} from "./multiplexer-dashboard-model.js";
import {
  ensureDashboardControlPlane as ensureDashboardControlPlaneImpl,
  getSelectedDashboardServiceForActions as getSelectedDashboardServiceForActionsImpl,
  getSelectedDashboardSessionForActions as getSelectedDashboardSessionForActionsImpl,
  getSelectedDashboardWorktreeEntry as getSelectedDashboardWorktreeEntryImpl,
  handleActiveDashboardOverlayKey as handleActiveDashboardOverlayKeyImpl,
  handleDashboardSubscreenNavigationKey as handleDashboardSubscreenNavigationKeyImpl,
  handleOrchestrationInputKey as handleOrchestrationInputKeyImpl,
  handleOrchestrationRoutePickerKey as handleOrchestrationRoutePickerKeyImpl,
  isDashboardScreen as isDashboardScreenImpl,
  noteLastUsedItem as noteLastUsedItemImpl,
  openLiveTmuxWindowForEntry as openLiveTmuxWindowForEntryImpl,
  openLiveTmuxWindowForService as openLiveTmuxWindowForServiceImpl,
  postToProjectService as postToProjectServiceImpl,
  renderActiveDashboardOverlay as renderActiveDashboardOverlayImpl,
  renderOrchestrationInput as renderOrchestrationInputImpl,
  renderOrchestrationRoutePicker as renderOrchestrationRoutePickerImpl,
  setDashboardScreen as setDashboardScreenImpl,
  showOrchestrationInput as showOrchestrationInputImpl,
  showOrchestrationRoutePicker as showOrchestrationRoutePickerImpl,
  syncTuiNotificationContext as syncTuiNotificationContextImpl,
  updateWorktreeSessions as updateWorktreeSessionsImpl,
} from "./multiplexer-dashboard-control.js";
import {
  activateNextAttentionEntry as activateNextAttentionEntryImpl,
  attentionScore as attentionScoreImpl,
  buildWorkflowEntriesForHost as buildWorkflowEntriesForHostImpl,
  cycleWorkflowFilter as cycleWorkflowFilterImpl,
  describeHandoffState as describeHandoffStateImpl,
  describeWorkflowFilter as describeWorkflowFilterImpl,
  getActivityEntries as getActivityEntriesImpl,
  getPreferredThreadIndexForParticipant as getPreferredThreadIndexForParticipantImpl,
  handleActivityKey as handleActivityKeyImpl,
  handleThreadReplyKey as handleThreadReplyKeyImpl,
  handleThreadsKey as handleThreadsKeyImpl,
  handleWorkflowKey as handleWorkflowKeyImpl,
  openRelevantThreadForSession as openRelevantThreadForSessionImpl,
  renderActivityDashboard as renderActivityDashboardImpl,
  renderThreadDetailsForHost as renderThreadDetailsForHostImpl,
  renderThreadReply as renderThreadReplyImpl,
  renderThreads as renderThreadsImpl,
  renderWorkflow as renderWorkflowImpl,
  renderWorkflowDetailsForHost as renderWorkflowDetailsForHostImpl,
  runReviewLifecycleAction as runReviewLifecycleActionImpl,
  runTaskLifecycleAction as runTaskLifecycleActionImpl,
  runThreadHandoffAction as runThreadHandoffActionImpl,
  runThreadStatusAction as runThreadStatusActionImpl,
  showActivityDashboard as showActivityDashboardImpl,
  showThreads as showThreadsImpl,
  showWorkflow as showWorkflowImpl,
} from "./multiplexer-subscreens.js";

export type MuxMode = "dashboard" | "project-service";

export interface SessionState {
  id: string;
  tool: string;
  toolConfigKey: string;
  command: string;
  args: string[];
  backendSessionId?: string;
  worktreePath?: string;
  label?: string;
  headline?: string;
  tmuxTarget?: TmuxTarget;
}

export interface ServiceState {
  id: string;
  worktreePath?: string;
  label?: string;
  launchCommandLine?: string;
}

export interface SavedState {
  savedAt: string;
  cwd: string;
  sessions: SessionState[];
  services?: ServiceState[];
}

type ManagedSession = SessionRuntime;

interface WorktreeRemovalJob {
  path: string;
  name: string;
  startedAt: number;
  oldIdx: number;
  stderr: string;
}

interface PlanEntry {
  sessionId: string;
  tool?: string;
  label?: string;
  worktree?: string;
  updatedAt?: string;
  path: string;
  content: string;
}

interface NotificationPanelState {
  entries: NotificationRecord[];
  index: number;
}

interface DashboardOrchestrationTarget {
  label: string;
  sessionId?: string;
  assignee?: string;
  tool?: string;
  worktreePath?: string;
  recipientIds?: string[];
}

export class Multiplexer {
  private readonly projectRoot: string;
  private sessions: ManagedSession[] = [];
  private offlineServices: ServiceState[] = [];
  private activeIndex = 0;
  private mode: MuxMode = "dashboard";
  private hotkeys: HotkeyHandler;
  private dashboard: Dashboard;
  private terminalHost: TerminalHost;
  private onStdinData: ((data: Buffer) => void) | null = null;
  private onResize: (() => void) | null = null;
  private resolveRun: ((code: number) => void) | null = null;
  private defaultCommand: string = "";
  private defaultArgs: string[] = [];
  private startedInDashboard = false;
  private pickerActive = false;
  private pickerMode: "create" | "fork" = "create";
  private forkSourceSessionId: string | null = null;
  private worktreeInputActive = false;
  private worktreeInputBuffer = "";
  private serviceInputActive = false;
  private serviceInputBuffer = "";
  private labelInputActive = false;
  private labelInputBuffer = "";
  private labelInputTarget: string | null = null;
  private orchestrationInputActive = false;
  private orchestrationInputBuffer = "";
  private orchestrationInputTarget: DashboardOrchestrationTarget | null = null;
  private orchestrationInputMode: "message" | "handoff" | "task" | null = null;
  private orchestrationRoutePickerActive = false;
  private orchestrationRouteMode: "message" | "handoff" | "task" | null = null;
  private orchestrationRouteOptions: DashboardOrchestrationTarget[] = [];
  private worktreeListActive = false;
  private worktreeRemoveConfirm: { path: string; name: string } | null = null;
  private worktreeRemovalJob: WorktreeRemovalJob | null = null;
  private readonly dashboardFeedback = new DashboardFeedbackController({
    renderDashboard: () => this.renderDashboard(),
    isDashboardMode: () => this.mode === "dashboard",
  });
  private migratePickerActive = false;
  private migratePickerWorktrees: Array<{ name: string; path: string }> = [];
  private graveyardEntries: SessionState[] = [];
  private graveyardIndex = 0;
  private activityEntries: DashboardSession[] = [];
  private activityIndex = 0;
  private workflowEntries: WorkflowEntry[] = [];
  private workflowIndex = 0;
  private workflowFilter: WorkflowFilter = "all";
  private threadEntries: ThreadEntry[] = [];
  private threadIndex = 0;
  private threadReplyActive = false;
  private threadReplyBuffer = "";
  private planEntries: PlanEntry[] = [];
  private planIndex = 0;
  private notificationPanelState: NotificationPanelState | null = null;
  private dashboardPendingActions = new DashboardPendingActions(() => {
    if (this.mode === "dashboard") {
      this.renderCurrentDashboardView();
    }
  });
  private stoppingSessionIds = new Set<string>();
  private graveyardAfterStopSessionIds = new Set<string>();
  /** Quick switcher overlay state */
  private switcherActive = false;
  private switcherIndex = 0;
  private switcherTimeout: ReturnType<typeof setTimeout> | null = null;
  /** MRU order of session IDs (most recent first) */
  private sessionMRU: string[] = [];
  /** Sessions confirmed registered in the instance registry (for claim detection) */
  private confirmedRegistered = new Set<string>();
  /** The focused worktree path on the dashboard (undefined = main repo) */
  private dashboardState = new DashboardState();
  private dashboardUiStateStore = new DashboardUiStateStore();
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private agentTracker = new AgentTracker();
  private instanceId = randomUUID();
  private contextWatcher = new ContextWatcher((target) =>
    this.tmuxRuntimeManager.captureTarget(target, { startLine: -120 }),
  );
  private taskDispatcher: TaskDispatcher | null = null;
  private orchestrationDispatcher: OrchestrationDispatcher | null = null;
  /** Maps session ID → toolConfigKey for state saving */
  private sessionToolKeys = new Map<string, string>();
  /** Maps session ID → original args (before preamble injection) */
  private sessionOriginalArgs = new Map<string, string[]>();
  /** Maps session ID → worktree path (if session runs in a worktree) */
  private sessionWorktreePaths = new Map<string, string>();
  /** Maps session ID → team role (e.g. "coder", "reviewer") */
  private sessionRoles = new Map<string, string>();
  /** Maps session ID → user-provided stable label */
  private sessionLabels = new Map<string, string>();
  /** Offline sessions from previous runs (loaded from state.json) */
  private offlineSessions: SessionState[] = [];
  /** Cross-instance discovery and claim/heartbeat ownership */
  private instanceDirectory = new InstanceDirectory();
  private tmuxRuntimeManager = new TmuxRuntimeManager();
  private sessionBootstrap = new SessionBootstrapService({
    tmuxRuntimeManager: this.tmuxRuntimeManager,
    getSessionLabel: (sessionId) => this.getSessionLabel(sessionId),
    getSessionRole: (sessionId) => this.sessionRoles.get(sessionId),
    getSessionWorktreePath: (sessionId) => this.sessionWorktreePaths.get(sessionId),
    getSessionTmuxTarget: (sessionId) => this.sessionTmuxTargets.get(sessionId),
  });
  private sessionTmuxTargets = new Map<string, TmuxTarget>();
  private metadataServer: MetadataServer | null = null;
  private eventBus = new ProjectEventBus();
  private pluginRuntime: PluginRuntime | null = null;
  private lastRenderedFrame: string | null = null;
  private lastStatuslineSnapshotKey: string | null = null;
  private desktopStateSnapshot: ReturnType<Multiplexer["buildDesktopStateSnapshot"]> | null = null;
  private dashboardSessionsCache: DashboardSession[] = [];
  private dashboardServicesCache: DashboardService[] = [];
  private dashboardWorktreeGroupsCache: WorktreeGroup[] = [];
  private dashboardMainCheckoutInfoCache = { name: "Main Checkout", branch: "" };
  private dashboardModelSnapshotKey: string | null = null;
  private dashboardModelRefreshedAt = 0;
  private dashboardServiceSnapshotRefreshing = false;
  private dashboardServiceRecovery: Promise<void> | null = null;
  private dashboardNextBackgroundRefreshAt = 0;
  private runtimeSync!: MultiplexerRuntimeSync;

  constructor() {
    this.projectRoot = (() => {
      try {
        return findMainRepo(process.cwd());
      } catch {
        return process.cwd();
      }
    })();
    this.terminalHost = new TerminalHost();
    this.hotkeys = new HotkeyHandler((action) => this.handleAction(action));
    this.dashboard = new Dashboard();
    this.runtimeSync = new MultiplexerRuntimeSync({
      instanceDirectory: this.instanceDirectory,
      instanceId: this.instanceId,
      cwd: process.cwd(),
      getMode: () => this.mode,
      getConfirmedRegistered: () => this.confirmedRegistered,
      setConfirmedRegistered: (value) => {
        this.confirmedRegistered = value;
      },
      getInstanceSessionRefs: () => this.getInstanceSessionRefs(),
      syncSessionsFromState: () => this.syncSessionsFromState(),
      loadOfflineSessions: () => this.loadOfflineSessions(),
      renderCurrentDashboardView: () => this.renderCurrentDashboardView(),
      renderDashboard: () => this.renderDashboard(),
      handleSessionClaimed: (sessionId) => this.handleSessionClaimed(sessionId),
      writeStatuslineFile: () => this.writeStatuslineFile(),
    });
    this.eventBus.subscribe((event) => {
      if (event.type !== "alert") return;
      if (event.kind === "notification") {
        this.footerFlash = `◌ ${event.title}`;
      } else if (event.kind === "needs_input") {
        this.footerFlash = `◉ ${event.sessionId ?? "agent"} needs input`;
      } else if (event.kind === "message_waiting") {
        this.footerFlash = `✉ Message waiting → ${event.sessionId ?? "agent"}`;
      } else if (event.kind === "handoff_waiting") {
        this.footerFlash = `⇢ Handoff waiting → ${event.sessionId ?? "agent"}`;
      } else if (event.kind === "task_assigned") {
        this.footerFlash = `⧫ Task assigned → ${event.sessionId ?? "agent"}`;
      } else if (event.kind === "review_waiting") {
        this.footerFlash = `◌ Review waiting → ${event.sessionId ?? "agent"}`;
      } else if (event.kind === "blocked") {
        this.footerFlash = `⧗ ${event.title}`;
      } else if (event.kind === "task_done") {
        this.footerFlash = `✓ ${event.title}`;
      } else if (event.kind === "task_failed") {
        this.footerFlash = `✗ ${event.title}`;
      }
      this.footerFlashTicks = 4;
    });
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  get activeSession(): ManagedSession | null {
    return this.sessions[this.activeIndex] ?? null;
  }

  private publishAlert(input: {
    kind: AlertKind;
    sessionId?: string;
    title: string;
    message: string;
    threadId?: string;
    taskId?: string;
    worktreePath?: string;
    dedupeKey?: string;
    cooldownMs?: number;
  }): void {
    this.eventBus.publishAlert(input);
  }

  private deriveSessionSemanticState(sessionId: string, status?: DashboardSession["status"]) {
    const derived = loadMetadataState().sessions[sessionId]?.derived;
    return deriveSessionSemantics({
      status: status ?? this.sessions.find((session) => session.id === sessionId)?.status ?? "offline",
      activity: derived?.activity,
      attention: derived?.attention,
      unseenCount: derived?.unseenCount,
      hasActiveTask: Boolean(this.taskDispatcher?.getSessionTask(sessionId)),
    });
  }

  private isTmuxBackend(): boolean {
    return true;
  }

  private openTmuxDashboardTarget(): void {
    openDashboardTarget(this.projectRoot, this.tmuxRuntimeManager);
  }

  private invalidateDashboardFrame(): void {
    this.lastRenderedFrame = null;
  }

  private isFocusInReport(data: Buffer): boolean {
    return data.includes(Buffer.from("\x1b[I"));
  }

  private handleDashboardFocusIn(): void {
    this.terminalHost.enterAlternateScreen();
    if (this.lastRenderedFrame) {
      process.stdout.write(this.lastRenderedFrame);
    }
    this.tmuxRuntimeManager.refreshStatus();
  }

  private loadDashboardUiState(): void {
    this.dashboardUiStateStore.loadInto(this.dashboardState);
  }

  private persistDashboardUiState(): void {
    this.dashboardUiStateStore.persist(this.mode, this.dashboardState, this.activeIndex, this.getDashboardSessions());
  }

  private restoreDashboardSelectionFromPreference(dashSessions: DashboardSession[], hasWorktrees: boolean): void {
    this.dashboardUiStateStore.consumeSelectionRestore(
      this.dashboardState,
      dashSessions,
      hasWorktrees,
      () => this.updateWorktreeSessions(),
      this.activeIndex,
      (value) => {
        this.activeIndex = value;
      },
    );
  }

  private writeFrame(output: string, force = false): void {
    if (!force && this.lastRenderedFrame === output) return;
    process.stdout.write(output);
    this.lastRenderedFrame = output;
  }

  private getViewportSize(): { cols: number; rows: number } {
    let cols = process.stdout.columns ?? 80;
    let rows = process.stdout.rows ?? 24;

    try {
      const paneRaw = this.tmuxRuntimeManager.displayMessage("#{pane_width}\t#{pane_height}");
      if (paneRaw) {
        const [tmuxColsRaw, tmuxRowsRaw] = paneRaw.split("\t");
        const tmuxCols = Number(tmuxColsRaw);
        const tmuxRows = Number(tmuxRowsRaw);
        if (Number.isFinite(tmuxCols) && tmuxCols > 0) cols = tmuxCols;
        if (Number.isFinite(tmuxRows) && tmuxRows > 0) rows = tmuxRows;
      } else {
        const clientRaw = this.tmuxRuntimeManager.displayMessage("#{client_width}\t#{client_height}");
        if (clientRaw) {
          const [tmuxColsRaw, tmuxRowsRaw] = clientRaw.split("\t");
          const tmuxCols = Number(tmuxColsRaw);
          const tmuxRows = Number(tmuxRowsRaw);
          if (Number.isFinite(tmuxCols) && tmuxCols > 0) cols = tmuxCols;
          if (Number.isFinite(tmuxRows) && tmuxRows > 0) rows = tmuxRows;
        }
      }
    } catch {}

    if (typeof process.stdout.getWindowSize === "function") {
      try {
        const [ttyCols, ttyRows] = process.stdout.getWindowSize();
        if (Number.isFinite(ttyCols) && ttyCols > cols) cols = ttyCols;
        if (Number.isFinite(ttyRows) && ttyRows > rows) rows = ttyRows;
      } catch {}
    }

    return { cols, rows };
  }

  private restoreDashboardAfterOverlayDismiss(): void {
    this.invalidateDashboardFrame();
    if (this.mode === "dashboard") {
      this.renderDashboard();
    } else {
      this.focusSession(this.activeIndex);
    }
  }

  private buildDashboardWorktreeGroups(
    dashSessions: DashboardSession[],
    dashServices: DashboardService[],
    worktrees: Array<{ name: string; path: string; branch: string; isBare: boolean }>,
    mainRepoPath?: string,
  ): WorktreeGroup[] {
    return buildDashboardWorktreeGroupsImpl(this, dashSessions, dashServices, worktrees, mainRepoPath);
  }

  private applyDashboardModel(
    dashSessions: DashboardSession[],
    dashServices: DashboardService[],
    worktreeGroups: WorktreeGroup[],
    mainCheckoutInfo: { name: string; branch: string },
  ): boolean {
    return applyDashboardModelImpl(this, dashSessions, dashServices, worktreeGroups, mainCheckoutInfo);
  }

  private invalidateDesktopStateSnapshot(): void {
    invalidateDesktopStateSnapshotImpl(this);
  }

  private refreshDesktopStateSnapshot(): void {
    refreshDesktopStateSnapshotImpl(this);
  }

  private computeDashboardSessions(): DashboardSession[] {
    return computeDashboardSessionsImpl(this);
  }

  private computeDashboardServices(worktrees = this.listDesktopWorktrees()): DashboardService[] {
    return computeDashboardServicesImpl(this, worktrees);
  }

  private readTmuxProcessInfo(target: TmuxTarget): {
    command?: string;
    pid?: number;
    previewLine?: string;
  } {
    return readTmuxProcessInfoImpl(this, target);
  }

  private buildDesktopStateSnapshot(): {
    sessions: DashboardSession[];
    services: DashboardService[];
    worktrees: Array<{ name: string; path: string; branch: string; isBare: boolean }>;
    mainCheckoutInfo: { name: string; branch: string };
    mainCheckoutPath?: string;
  } {
    return buildDesktopStateSnapshotImpl(this);
  }

  private async refreshDashboardModelFromService(force = false): Promise<boolean> {
    return refreshDashboardModelFromServiceImpl(this, force);
  }

  private refreshLocalDashboardModel(): void {
    refreshLocalDashboardModelImpl(this);
  }

  private async startProjectServices(): Promise<void> {
    await startProjectServicesImpl(this);
  }

  private composeOrchestrationPrompt(
    threadId: string,
    from: string,
    body: string,
    kind: MessageKind,
    title?: string,
  ): string {
    const prefix = `[AIMUX MESSAGE ${threadId} from ${from}]`;
    const headline = title ? `${title}\n\n` : "";
    return (
      `${prefix} ${headline}${body}\n\n` +
      `Read .aimux/threads/${threadId}.json and .aimux/threads/${threadId}.jsonl for context. ` +
      `This is a ${kind} message. Reply in-thread if needed.`
    );
  }

  private orchestrationWorkflowPressure(sessionId: string, status?: DashboardSession["status"]): number {
    const semantic = this.deriveSessionSemanticState(sessionId, status);
    return (
      semantic.waitingOnMeCount * 5 +
      semantic.blockedCount * 6 +
      semantic.pendingDeliveryCount * 3 +
      semantic.unreadCount * 2 +
      semantic.waitingOnThemCount
    );
  }

  private deliverOrchestrationMessage(
    recipients: string[],
    threadId: string,
    from: string,
    body: string,
    kind: MessageKind,
    title?: string,
    messageId?: string,
  ): string[] {
    const delivered: string[] = [];
    for (const recipient of recipients) {
      const session = this.sessions.find((candidate) => candidate.id === recipient && !candidate.exited);
      if (!session) continue;
      const availability = this.deriveSessionSemanticState(session.id, session.status).availability;
      if (availability === "blocked" || availability === "offline" || availability === "needs_input") continue;
      if (availability !== "available" && availability !== "busy") continue;
      session.write(this.composeOrchestrationPrompt(threadId, from, body, kind, title) + "\r");
      if (messageId) {
        markMessageDelivered(threadId, messageId, recipient);
      }
      delivered.push(recipient);
    }
    return delivered;
  }

  private sendOrchestrationMessage(input: {
    threadId?: string;
    from?: string;
    to?: string[];
    assignee?: string;
    tool?: string;
    worktreePath?: string;
    kind?: MessageKind;
    body: string;
    title?: string;
  }): { thread: unknown; message: unknown; deliveredTo: string[]; threadCreated: boolean } {
    const from = input.from?.trim() || "user";
    const kind = input.kind ?? "request";
    const resolvedRecipients =
      input.threadId && !input.to?.length
        ? undefined
        : resolveOrchestrationRecipients({
            candidates: this.sessions.map((session) => ({
              id: session.id,
              tool: this.sessionToolKeys.get(session.id),
              role: this.sessionRoles.get(session.id),
              worktreePath: this.sessionWorktreePaths.get(session.id),
              status: session.status,
              availability: this.deriveSessionSemanticState(session.id, session.status).availability,
              workflowPressure: this.orchestrationWorkflowPressure(session.id, session.status),
              exited: session.exited,
            })),
            to: input.to,
            assignee: input.assignee,
            tool: input.tool,
            worktreePath: input.worktreePath,
          });
    const result = input.threadId
      ? sendThreadMessage({
          threadId: input.threadId,
          from,
          to: resolvedRecipients,
          kind,
          body: input.body,
        })
      : sendDirectMessage({
          from,
          to: resolvedRecipients ?? [],
          kind: kind as any,
          body: input.body,
          title: input.title,
          worktreePath: input.worktreePath,
        });
    const deliveredTo = this.deliverOrchestrationMessage(
      result.message.to ?? [],
      result.thread.id,
      from,
      input.body,
      kind,
      result.thread.title,
      result.message.id,
    );
    this.writeStatuslineFile();
    if (this.mode === "dashboard") {
      this.renderCurrentDashboardView();
    }
    return {
      thread: result.thread,
      message: result.message,
      deliveredTo,
      threadCreated: result.threadCreated,
    };
  }

  private sendHandoffMessage(input: {
    from?: string;
    to?: string[];
    assignee?: string;
    tool?: string;
    body: string;
    title?: string;
    worktreePath?: string;
  }): { thread: unknown; message: unknown; deliveredTo: string[]; threadCreated: boolean } {
    const from = input.from?.trim() || "user";
    const resolvedRecipients = resolveOrchestrationRecipients({
      candidates: this.sessions.map((session) => ({
        id: session.id,
        tool: this.sessionToolKeys.get(session.id),
        role: this.sessionRoles.get(session.id),
        worktreePath: this.sessionWorktreePaths.get(session.id),
        status: session.status,
        availability: this.deriveSessionSemanticState(session.id, session.status).availability,
        workflowPressure: this.orchestrationWorkflowPressure(session.id, session.status),
        exited: session.exited,
      })),
      to: input.to,
      assignee: input.assignee,
      tool: input.tool,
      worktreePath: input.worktreePath,
    });
    const result = sendHandoff({
      from,
      to: resolvedRecipients,
      body: input.body,
      title: input.title,
      worktreePath: input.worktreePath,
    });
    const deliveredTo = this.deliverOrchestrationMessage(
      result.message.to ?? [],
      result.thread.id,
      from,
      input.body,
      "handoff",
      result.thread.title,
      result.message.id,
    );
    this.writeStatuslineFile();
    if (this.mode === "dashboard") {
      this.renderCurrentDashboardView();
    }
    return {
      thread: result.thread,
      message: result.message,
      deliveredTo,
      threadCreated: result.threadCreated,
    };
  }

  private async stopProjectServices(): Promise<void> {
    await stopProjectServicesImpl(this);
  }

  private getSessionLabel(sessionId: string): string | undefined {
    return this.sessionLabels.get(sessionId) ?? this.offlineSessions.find((session) => session.id === sessionId)?.label;
  }

  private applySessionLabel(sessionId: string, label?: string): void {
    const trimmed = label?.trim();
    if (trimmed) {
      this.sessionLabels.set(sessionId, trimmed);
    } else {
      this.sessionLabels.delete(sessionId);
    }

    const offline = this.offlineSessions.find((session) => session.id === sessionId);
    if (offline) {
      if (trimmed) offline.label = trimmed;
      else delete offline.label;
    }
  }

  private applyDashboardSessionLabel(sessionId: string, label?: string): void {
    const trimmed = label?.trim();
    this.dashboardSessionsCache = this.dashboardSessionsCache.map((session) =>
      session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
    );
    this.dashboardWorktreeGroupsCache = this.dashboardWorktreeGroupsCache.map((group) => ({
      ...group,
      sessions: group.sessions.map((session) =>
        session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
      ),
    }));
    this.dashboardState.worktreeSessions = this.dashboardState.worktreeSessions.map((session) =>
      session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
    );
  }

  private async updateSessionLabel(sessionId: string, label?: string): Promise<void> {
    if (this.mode === "dashboard") {
      this.applySessionLabel(sessionId, label);
      this.applyDashboardSessionLabel(sessionId, label);
      this.setPendingDashboardSessionAction(sessionId, "renaming");
      this.writeStatuslineFile();
      this.renderCurrentDashboardView();
      void this.postToProjectService("/agents/rename", { sessionId, label })
        .then(() => {
          this.invalidateDesktopStateSnapshot();
          this.setPendingDashboardSessionAction(sessionId, null);
          this.writeStatuslineFile();
          this.renderCurrentDashboardView();
        })
        .catch((err) => {
          this.setPendingDashboardSessionAction(sessionId, null);
          this.footerFlash = `Rename failed: ${err instanceof Error ? err.message : String(err)}`;
          this.footerFlashTicks = 4;
          this.writeStatuslineFile();
          this.renderCurrentDashboardView();
        });
      return;
    }

    this.applySessionLabel(sessionId, label);
    this.invalidateDesktopStateSnapshot();

    const localSession = this.sessions.find((session) => session.id === sessionId)?.transport;
    if (localSession instanceof TmuxSessionTransport) {
      localSession.renameWindow(localSession.command);
      const target = localSession.tmuxTarget;
      this.sessionTmuxTargets.set(sessionId, target);
      this.syncTmuxWindowMetadata(sessionId);
    }

    this.saveState();
    this.writeStatuslineFile();

    this.renderDashboard();
  }

  private readStatusHeadline(sessionId: string): string | undefined {
    try {
      const statusPath = join(getStatusDir(), `${sessionId}.md`);
      if (!existsSync(statusPath)) return undefined;
      const content = readFileSync(statusPath, "utf-8").trim();
      if (!content) return undefined;
      return content.split("\n")[0].slice(0, 80);
    } catch {
      return undefined;
    }
  }

  private deriveHeadline(sessionId: string): string | undefined {
    const taskDescription = this.taskDispatcher?.getSessionTask(sessionId);
    if (taskDescription) return taskDescription.slice(0, 80);

    const statusHeadline = this.readStatusHeadline(sessionId);
    if (statusHeadline) return statusHeadline;

    try {
      const turns = readHistory(sessionId, { lastN: 3 });
      const lastPrompt = turns.filter((turn) => turn.type === "prompt").pop();
      if (lastPrompt) return lastPrompt.content.slice(0, 80);
    } catch {}

    return undefined;
  }

  private resolveRunningSession(sessionId: string): ManagedSession {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.exited) {
      throw new Error(`Session "${sessionId}" is not running`);
    }
    return session;
  }

  private writeTmuxAgentInput(sessionId: string, transport: TmuxSessionTransport, data: string): void {
    const target = this.sessionTmuxTargets.get(sessionId) ?? transport.tmuxTarget;
    let textBuffer = "";
    const flushText = () => {
      if (!textBuffer) return;
      this.tmuxRuntimeManager.sendText(target, textBuffer);
      textBuffer = "";
    };

    for (const ch of data) {
      if (ch === "\r") {
        flushText();
        this.tmuxRuntimeManager.sendEnter(target);
        continue;
      }
      if (ch === "\n") {
        flushText();
        this.tmuxRuntimeManager.sendKey(target, "C-j");
        continue;
      }
      textBuffer += ch;
    }

    flushText();
  }

  private normalizeAgentInput(data: string, submit: boolean): string {
    if (!submit) return data;
    return data.replace(/(?:\r\n|\r|\n)+$/g, "");
  }

  private paneStillContainsAgentDraft(target: TmuxTarget, draft: string): boolean {
    try {
      const pane = this.tmuxRuntimeManager.captureTarget(target, { startLine: -60 });
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const normalizedDraft = normalize(draft);
      if (!normalizedDraft) return false;
      return normalize(pane).includes(normalizedDraft);
    } catch {
      return false;
    }
  }

  private scheduleTmuxAgentSubmit(sessionId: string, target: TmuxTarget, draft: string): void {
    const submitOnce = () => {
      try {
        this.tmuxRuntimeManager.sendEnter(target);
      } catch {}
    };

    const step = (attempt = 1) => {
      if (attempt > 4) return;
      setTimeout(
        () => {
          try {
            const currentTarget = this.sessionTmuxTargets.get(sessionId);
            if (!currentTarget || currentTarget.windowId !== target.windowId) {
              return;
            }
            submitOnce();
            if (attempt >= 4) return;
            setTimeout(() => {
              try {
                if (this.paneStillContainsAgentDraft(target, draft)) {
                  step(attempt + 1);
                }
              } catch {}
            }, 700);
          } catch {}
        },
        attempt === 1 ? 150 : 700,
      );
    };

    step();
  }

  async writeAgentInput(
    sessionId: string,
    data = "",
    parts?: AgentInputPart[],
    clientMessageId?: string,
    submit = false,
  ): Promise<{ sessionId: string }> {
    const session = this.resolveRunningSession(sessionId);
    appendSessionMessage(sessionId, { data, parts, clientMessageId });
    const serializedData = serializeAgentInput(
      { data, parts },
      {
        tool: this.sessionToolKeys.get(sessionId),
        resolveAttachmentPath,
      },
    );
    const normalizedData = this.normalizeAgentInput(serializedData, submit);
    if (!normalizedData && !submit) {
      throw new Error("input data is required");
    }
    if (session.transport instanceof TmuxSessionTransport) {
      if (normalizedData) {
        this.writeTmuxAgentInput(sessionId, session.transport, normalizedData);
      }
      if (submit) {
        const target = this.sessionTmuxTargets.get(sessionId) ?? session.transport.tmuxTarget;
        this.scheduleTmuxAgentSubmit(sessionId, target, normalizedData);
      }
    } else {
      session.write(submit ? `${normalizedData}\r` : normalizedData);
    }
    return { sessionId };
  }

  async readAgentHistory(
    sessionId: string,
    lastN?: number,
  ): Promise<{ sessionId: string; messages: ReturnType<typeof readSessionMessages>; lastN?: number }> {
    this.resolveRunningSession(sessionId);
    return {
      sessionId,
      messages: readSessionMessages(sessionId, { lastN: lastN ?? 20 }),
      lastN: lastN ?? 20,
    };
  }

  async interruptAgent(sessionId: string): Promise<{ sessionId: string }> {
    const session = this.resolveRunningSession(sessionId);
    if (session.transport instanceof TmuxSessionTransport) {
      const target = this.sessionTmuxTargets.get(sessionId) ?? session.transport.tmuxTarget;
      this.tmuxRuntimeManager.sendEscape(target);
    } else {
      session.write("\x1b");
    }
    return { sessionId };
  }

  async readAgentOutput(
    sessionId: string,
    startLine?: number,
  ): Promise<{ sessionId: string; output: string; startLine?: number; parsed: ParsedAgentOutput }> {
    this.resolveRunningSession(sessionId);
    const target = this.sessionTmuxTargets.get(sessionId);
    if (!target) {
      throw new Error(`Session "${sessionId}" does not have a tmux target`);
    }
    const output = this.tmuxRuntimeManager.captureTarget(target, {
      startLine: startLine ?? -120,
    });
    return {
      sessionId,
      output,
      startLine: startLine ?? -120,
      parsed: parseAgentOutput(output, {
        tool: this.sessionToolKeys.get(sessionId),
      }),
    };
  }

  private registerManagedSession(
    session: SessionTransport,
    args: string[],
    toolConfigKey?: string,
    worktreePath?: string,
    role?: string,
    startTime?: number,
  ): ManagedSession {
    const existing = this.sessions.find((runtime) => runtime.transport === session);
    if (existing) return existing;

    const runtime = new SessionRuntime(session, startTime, {
      onEvent: (event) => this.handleSessionRuntimeEvent(runtime, event),
    });

    if (toolConfigKey) {
      this.sessionToolKeys.set(runtime.id, toolConfigKey);
    }
    this.sessionOriginalArgs.set(runtime.id, args);
    if (worktreePath) {
      this.sessionWorktreePaths.set(runtime.id, worktreePath);
    }
    if (role) {
      this.sessionRoles.set(runtime.id, role);
    } else if (!this.sessionRoles.has(runtime.id)) {
      try {
        const teamConfig = loadTeamConfig();
        this.sessionRoles.set(runtime.id, teamConfig.defaultRole);
      } catch {}
    }
    const label = this.offlineSessions.find((offline) => offline.id === runtime.id)?.label;
    if (label) {
      this.sessionLabels.set(runtime.id, label);
    }

    this.sessions.push(runtime);
    this.writeSessionsFile();
    this.updateContextWatcherSessions();
    if (this.sessions.length === 1) this.contextWatcher.start();
    return runtime;
  }

  private handleSessionRuntimeEvent(runtime: ManagedSession, event: SessionRuntimeEvent): void {
    if (event.type === "output") {
      this.writeStatuslineFile();
      return;
    }

    if (event.type !== "exit") return;
    const _code = event.code;

    debug(`session exited: ${runtime.id} (code=${_code})`, "session");

    const uptime = runtime.startTime ? Date.now() - runtime.startTime : Infinity;
    let errorHint = "";
    if (_code !== 0 && uptime < 10_000) {
      const sessionCwd = this.sessionWorktreePaths.get(runtime.id);
      const searchDirs = [getProjectStateDir(), sessionCwd ? getAimuxDirFor(sessionCwd) : null].filter(
        Boolean,
      ) as string[];
      for (const dir of searchDirs) {
        if (errorHint) break;
        try {
          const logPath = join(dir, "recordings", `${runtime.id}.log`);
          if (existsSync(logPath)) {
            const raw = readFileSync(logPath, "utf-8");
            const lines = raw
              .split("\n")
              .map((l) => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim())
              .filter(Boolean);
            const errorLine = lines.find(
              (l) => l.includes("Error") || l.includes("error") || l.includes("unmatched") || l.includes("not found"),
            );
            if (errorLine) errorHint = `: ${errorLine.slice(0, 60)}`;
          }
        } catch {}
      }
      this.footerFlash = `✗ ${runtime.id} crashed (code ${_code})${errorHint}`;
      this.footerFlashTicks = 8;
      debug(`quick crash: ${runtime.id} (code=${_code}, uptime=${uptime}ms)${errorHint}`, "session");
    }

    if (_code !== 0) {
      this.publishAlert({
        kind: "task_failed",
        sessionId: runtime.id,
        title: `${runtime.id} failed`,
        message: errorHint ? `Agent exited with code ${_code}${errorHint}` : `Agent exited with code ${_code}.`,
        dedupeKey: `exit-failed:${runtime.id}`,
        cooldownMs: 15_000,
      });
    }
    captureGitContext(runtime.id, runtime.command).catch(() => {});

    const idx = this.sessions.indexOf(runtime);
    if (idx === -1) return;

    this.sessions.splice(idx, 1);
    this.stoppingSessionIds.delete(runtime.id);
    this.writeSessionsFile();
    this.updateContextWatcherSessions();
    const mappedTarget = this.sessionTmuxTargets.get(runtime.id);
    const runtimeTarget = runtime.transport instanceof TmuxSessionTransport ? runtime.transport.tmuxTarget : undefined;
    if (!mappedTarget || !runtimeTarget || mappedTarget.windowId === runtimeTarget.windowId) {
      this.sessionTmuxTargets.delete(runtime.id);
    }
    this.saveState();

    if (this.sessions.length === 0) {
      if (this.startedInDashboard) {
        this.renderDashboard();
        return;
      }
      this.resolveRun?.(_code);
      return;
    }

    if (this.activeIndex >= this.sessions.length) {
      this.activeIndex = this.sessions.length - 1;
    }

    this.renderDashboard();
  }

  private buildTmuxWindowMetadata(sessionId: string, command: string): TmuxWindowMetadata {
    const sessionMetadata = loadMetadataState().sessions[sessionId];
    return {
      kind: "agent",
      sessionId,
      command,
      args: this.sessionOriginalArgs.get(sessionId) ?? [],
      toolConfigKey: this.sessionToolKeys.get(sessionId) ?? command,
      backendSessionId: this.sessions.find((session) => session.id === sessionId)?.backendSessionId,
      worktreePath: this.sessionWorktreePaths.get(sessionId),
      label: this.getSessionLabel(sessionId),
      role: this.sessionRoles.get(sessionId),
      activity: sessionMetadata?.derived?.activity,
      attention: sessionMetadata?.derived?.attention,
      unseenCount: sessionMetadata?.derived?.unseenCount,
      statusText: sessionMetadata?.status?.text,
    };
  }

  private syncTmuxWindowMetadata(sessionId: string): void {
    const runtime = this.sessions.find((session) => session.id === sessionId);
    if (!runtime || !(runtime.transport instanceof TmuxSessionTransport)) return;
    const metadata = this.buildTmuxWindowMetadata(sessionId, runtime.command);
    this.tmuxRuntimeManager.setWindowMetadata(runtime.transport.tmuxTarget, metadata);
    this.tmuxRuntimeManager.applyManagedAgentWindowPolicy(runtime.transport.tmuxTarget, metadata.toolConfigKey);
  }

  private updateContextWatcherSessions(): void {
    this.contextWatcher.updateSessions(
      this.sessions.map((s) => {
        const key = this.sessionToolKeys.get(s.id);
        const tc = key ? loadConfig().tools[key] : undefined;
        return {
          id: s.id,
          command: s.command,
          turnPatterns: tc?.turnPatterns?.map((p) => new RegExp(p)),
          tmuxTarget: this.sessionTmuxTargets.get(s.id),
        };
      }),
    );
  }

  async run(opts: { command: string; args: string[] }): Promise<number> {
    initProject();
    await this.instanceDirectory.registerInstance(this.instanceId, process.cwd());
    this.startHeartbeat();
    this.syncSessionsFromState();
    this.taskDispatcher = new TaskDispatcher(
      (id) => this.sessions.find((s) => s.id === id),
      (id) => this.sessionToolKeys.get(id),
      (id) => this.sessionRoles.get(id),
      (id) => this.deriveSessionSemanticState(id).availability,
    );
    this.orchestrationDispatcher = new OrchestrationDispatcher((id) => this.sessions.find((s) => s.id === id));
    this.defaultCommand = opts.command;
    this.defaultArgs = opts.args;

    // Look up preamble flag and config key from config
    const config = loadConfig();
    const toolEntry = Object.entries(config.tools).find(([, t]) => t.command === opts.command);
    const toolConfig = toolEntry?.[1];
    const toolConfigKey = toolEntry?.[0];

    // Write instruction files for tools that need them (e.g. CODEX.md)
    this.writeInstructionFiles();

    // Create initial session
    this.createSession(
      opts.command,
      opts.args,
      toolConfig?.preambleFlag,
      toolConfigKey,
      undefined,
      toolConfig?.sessionIdFlag,
    );

    this.focusSession(this.sessions.length - 1);
    return 0;
  }

  async runDashboard(): Promise<number> {
    initProject();
    await this.instanceDirectory.registerInstance(this.instanceId, process.cwd());
    this.startHeartbeat();
    this.startedInDashboard = true;
    this.mode = "dashboard";
    this.syncSessionsFromState();

    // Load config to set default tool for session creation
    const config = loadConfig();
    const defaultTool = config.tools[config.defaultTool];
    if (defaultTool) {
      this.defaultCommand = defaultTool.command;
      this.defaultArgs = defaultTool.args;
    }

    this.writeInstructionFiles();
    this.terminalHost.enterRawMode();

    // Forward stdin
    this.onStdinData = (data: Buffer) => {
      if (this.isFocusInReport(data)) {
        this.handleDashboardFocusIn();
        return;
      }
      if (this.handleActiveDashboardOverlayKey(data)) {
        return;
      }
      if (this.isDashboardScreen("activity")) {
        this.handleActivityKey(data);
        return;
      }
      if (this.isDashboardScreen("workflow")) {
        this.handleWorkflowKey(data);
        return;
      }
      if (this.isDashboardScreen("threads")) {
        this.handleThreadsKey(data);
        return;
      }
      if (this.isDashboardScreen("plans")) {
        this.handlePlansKey(data);
        return;
      }
      if (this.isDashboardScreen("help")) {
        this.handleHelpKey(data);
        return;
      }
      if (this.isDashboardScreen("graveyard")) {
        this.handleGraveyardKey(data);
        return;
      }

      if (this.mode === "dashboard") {
        this.handleDashboardKey(data);
        return;
      }
    };
    process.stdin.on("data", this.onStdinData);

    // Forward terminal resize
    this.onResize = () => {
      this.renderCurrentDashboardView();
    };
    process.stdout.on("resize", this.onResize);

    // Enter dashboard mode directly
    this.mode = "dashboard";
    this.loadDashboardUiState();
    const primed = await this.refreshDashboardModelFromService(true);
    if (!primed) {
      throw new Error("dashboard requires a live project service desktop-state endpoint");
    }
    this.terminalHost.enterAlternateScreen(true);
    this.startStatusRefresh();
    this.renderDashboard();

    const exitCode = await new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });

    this.teardown();
    return exitCode;
  }

  async runProjectService(): Promise<number> {
    initProject();
    this.mode = "project-service";
    this.syncSessionsFromState();
    this.taskDispatcher = new TaskDispatcher(
      (id) => this.sessions.find((s) => s.id === id),
      (id) => this.sessionToolKeys.get(id),
      (id) => this.sessionRoles.get(id),
      (id) => this.deriveSessionSemanticState(id).availability,
    );
    this.orchestrationDispatcher = new OrchestrationDispatcher((id) => this.sessions.find((s) => s.id === id));
    this.writeInstructionFiles();
    await this.startProjectServices();
    this.refreshDesktopStateSnapshot();
    this.writeStatuslineFile();
    this.startStatusRefresh();
    this.startProjectServiceRefresh();

    const exitCode = await new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });

    this.teardown();
    return exitCode;
  }

  /**
   * Resume previous sessions using each tool's native resume mechanism.
   * Reads state.json and spawns sessions with resumeArgs instead of normal args.
   */
  async resumeSessions(toolFilter?: string): Promise<number> {
    initProject();
    await this.instanceDirectory.registerInstance(this.instanceId, process.cwd());
    this.startHeartbeat();
    const state = Multiplexer.loadState();
    if (!state || state.sessions.length === 0) {
      console.error("No saved session state found (or state is stale). Starting fresh.");
      return this.runDashboard();
    }

    const config = loadConfig();
    const sessionsToResume = toolFilter
      ? state.sessions.filter((s) => s.tool === toolFilter || s.toolConfigKey === toolFilter)
      : state.sessions;

    if (sessionsToResume.length === 0) {
      console.error(`No saved sessions found for tool "${toolFilter}". Starting fresh.`);
      return this.runDashboard();
    }

    const ownedByOthers = this.getRemoteOwnedSessionKeys();

    // Spawn each session with resumeArgs, substituting backend session ID
    for (const saved of sessionsToResume) {
      // Skip sessions owned by another live instance
      if (ownedByOthers.has(saved.id) || (saved.backendSessionId && ownedByOthers.has(saved.backendSessionId))) {
        debug(`skipping resume of ${saved.id} — owned by another instance`, "session");
        continue;
      }

      const toolCfg = config.tools[saved.toolConfigKey];
      if (!toolCfg) continue;

      const bsid = saved.backendSessionId;
      let resumeArgs: string[];
      if (this.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, bsid)) {
        // Substitute backend session ID into resume args
        resumeArgs = toolCfg.resumeArgs!.map((a: string) => a.replace("{sessionId}", bsid!));
      } else {
        // No valid backend resume path — use tool's configured fallback
        resumeArgs = toolCfg.resumeFallback ?? [];
      }
      const args = this.sessionBootstrap.composeToolArgs(toolCfg, resumeArgs, saved.args);
      debug(`resuming ${saved.command} with backendSessionId=${bsid ?? "none (fallback)"}`, "session");
      this.createSession(
        saved.command,
        args,
        toolCfg.preambleFlag,
        saved.toolConfigKey,
        undefined,
        undefined,
        saved.worktreePath,
        saved.backendSessionId,
      );
    }

    this.openTmuxDashboardTarget();
    return 0;
  }

  /**
   * Restore previous sessions by injecting prior history into the preamble.
   * Starts fresh sessions but with context from the previous conversation.
   */
  async restoreSessions(toolFilter?: string): Promise<number> {
    initProject();
    const state = Multiplexer.loadState();
    if (!state || state.sessions.length === 0) {
      console.error("No saved session state found (or state is stale). Starting fresh.");
      return this.runDashboard();
    }

    const config = loadConfig();
    const sessionsToRestore = toolFilter
      ? state.sessions.filter((s) => s.tool === toolFilter || s.toolConfigKey === toolFilter)
      : state.sessions;

    if (sessionsToRestore.length === 0) {
      console.error(`No saved sessions found for tool "${toolFilter}". Starting fresh.`);
      return this.runDashboard();
    }

    // Spawn each session with extended preamble containing prior history
    for (const saved of sessionsToRestore) {
      const toolCfg = config.tools[saved.toolConfigKey];
      if (!toolCfg) continue;

      // Read last 20 turns from this session's history
      const turns = readHistory(saved.id, { lastN: 20 });
      let historyContext = "";
      if (turns.length > 0) {
        const formattedTurns = turns.map((t) => {
          const time = t.ts.slice(0, 16);
          if (t.type === "prompt") return `[${time}] User: ${t.content}`;
          if (t.type === "response") return `[${time}] Agent: ${t.content}`;
          if (t.type === "git") return `[${time}] Git: ${t.content}${t.files ? ` (${t.files.join(", ")})` : ""}`;
          return `[${time}] ${t.content}`;
        });
        historyContext =
          "\n\n=== Your previous session context ===\n" +
          "You were previously working in this codebase. Here's what happened:\n" +
          formattedTurns.join("\n") +
          "\n=== End previous context ===\n";
      }

      // Also include live.md for cross-agent context
      const liveContext = buildContextPreamble(sessionsToRestore.filter((s) => s.id !== saved.id).map((s) => s.id));

      const extraPreamble = historyContext + (liveContext ? "\n" + liveContext : "");

      this.createSession(
        saved.command,
        saved.args,
        toolCfg.preambleFlag,
        saved.toolConfigKey,
        extraPreamble.trim() || undefined,
        undefined,
        saved.worktreePath,
      );
    }

    this.openTmuxDashboardTarget();
    return 0;
  }

  createSession(
    command: string,
    args: string[],
    preambleFlag?: string[],
    toolConfigKey?: string,
    extraPreamble?: string,
    sessionIdFlag?: string[],
    worktreePath?: string,
    backendSessionIdOverride?: string,
    sessionIdOverride?: string,
    detachedInTmux = false,
  ): SessionTransport {
    const cols = process.stdout.columns ?? 80;

    // Pre-generate session ID so we can reference it in the preamble
    const sessionId = sessionIdOverride ?? `${command}-${Math.random().toString(36).slice(2, 8)}`;

    // Generate a backend session UUID for tools that support it (e.g. claude --session-id)
    const backendSessionId = backendSessionIdOverride ?? (sessionIdFlag ? randomUUID() : undefined);

    // Inject aimux preamble via tool-specific flag if available
    const preamble = this.sessionBootstrap.buildSessionPreamble({
      sessionId,
      command,
      worktreePath,
      extraPreamble,
    });

    this.sessionBootstrap.ensurePlanFile(sessionId, command, worktreePath);

    let finalArgs = preambleFlag ? [...args, ...preambleFlag, preamble] : [...args];
    let launchCommand = command;

    // Inject backend session ID flag (e.g. --session-id <uuid>)
    if (sessionIdFlag && backendSessionId) {
      const expandedFlag = sessionIdFlag.map((a) => a.replace("{sessionId}", backendSessionId));
      finalArgs = [...finalArgs, ...expandedFlag];
    }

    const toolCfg = toolConfigKey ? loadConfig().tools[toolConfigKey] : undefined;
    let projectRoot = process.cwd();
    try {
      projectRoot = findMainRepo(worktreePath ?? process.cwd());
    } catch {
      projectRoot = process.cwd();
    }

    if (toolCfg && toolConfigKey === "claude" && toolCfg.command === command && toolCfg.wrapperEnabled !== false) {
      finalArgs = injectClaudeHookArgs(finalArgs, {
        sessionId,
        projectRoot,
        backendSessionId,
      });
      launchCommand = toolCfg.command;
    } else if (toolCfg && toolCfg.command === command) {
      const wrapped = wrapCommandWithShellIntegration({
        projectRoot,
        sessionId,
        tool: toolConfigKey ?? command,
        command: launchCommand,
        args: finalArgs,
      });
      launchCommand = wrapped.command;
      finalArgs = wrapped.args;
    }

    if (preambleFlag) {
      this.sessionBootstrap.finalizePreamble(command, preamble);
    }
    debug(
      `creating session: ${command} (configKey=${toolConfigKey ?? "cli"}, backendId=${backendSessionId ?? "none"}, cwd=${worktreePath ?? process.cwd()}, args=${finalArgs.length})`,
      "session",
    );
    // Log full args for debugging spawn failures
    debug(
      `spawn args: ${JSON.stringify(finalArgs.map((a) => (a.length > 100 ? a.slice(0, 100) + "..." : a)))}`,
      "session",
    );

    const sessionStartTime = Date.now();

    const tmuxSession = this.tmuxRuntimeManager.ensureProjectSession(process.cwd());
    const target = this.tmuxRuntimeManager.createWindow(
      tmuxSession.sessionName,
      this.getSessionLabel(sessionId) ?? command,
      worktreePath ?? process.cwd(),
      launchCommand,
      finalArgs,
      { detached: detachedInTmux },
    );
    const tmuxTransport = new TmuxSessionTransport(
      sessionId,
      command,
      target,
      this.tmuxRuntimeManager,
      cols,
      process.stdout.rows ?? 24,
    );
    this.sessionTmuxTargets.set(sessionId, target);
    const session: SessionTransport = tmuxTransport;
    this.registerManagedSession(tmuxTransport, args, toolConfigKey, worktreePath, undefined, sessionStartTime);

    // Store backend session ID and start time
    session.backendSessionId = backendSessionId;
    if (session instanceof TmuxSessionTransport) {
      this.syncTmuxWindowMetadata(sessionId);
    }

    this.activeIndex = this.sessions.length - 1;
    if (this.startedInDashboard && this.mode === "dashboard") {
      this.invalidateDesktopStateSnapshot();
      this.refreshLocalDashboardModel();
      this.updateWorktreeSessions();
      this.preferDashboardEntrySelection("session", sessionId, worktreePath);
      this.renderDashboard();
    }

    this.saveState();

    return session;
  }

  /**
   * Migrate an agent from its current worktree to a target worktree.
   * Copies history and context, kills the old session, starts a new one
   * with injected prior history.
   */
  async migrateAgent(sessionId: string, targetWorktreePath: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const sourceWorktree = this.sessionWorktreePaths.get(sessionId);
    const sourceCwd = sourceWorktree ?? process.cwd();

    // Get tool config for the session
    const toolConfigKey = this.sessionToolKeys.get(sessionId) ?? session.command;
    const config = loadConfig();
    const toolCfg = config.tools[toolConfigKey];
    const originalArgs = this.sessionOriginalArgs.get(sessionId) ?? [];

    const backendSessionId = session.backendSessionId as string | undefined;
    let migrateArgs = originalArgs;
    let historyContext = "";
    const useBackendResume = this.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, backendSessionId);
    await this.contextWatcher.syncNow(sessionId).catch(() => {});
    const sourceSnapshot = this.sessionBootstrap.readForkSourceSnapshot(sessionId);

    if (useBackendResume) {
      migrateArgs = this.sessionBootstrap.composeToolArgs(
        toolCfg,
        toolCfg!.resumeArgs!.map((arg) => arg.replace("{sessionId}", backendSessionId!)),
        originalArgs,
      );
    } else {
      // Fall back to context injection when the tool has no real backend resume path.
      if (sourceSnapshot.historyText) {
        historyContext =
          "\n\n=== Your previous session context ===\n" +
          "You were previously working in a different worktree. Here's what happened:\n" +
          sourceSnapshot.historyText +
          "\n=== End previous context ===\n";
      } else if (sourceSnapshot.liveText) {
        historyContext =
          "\n\n=== Your previous session context ===\n" +
          "You were previously working in a different worktree. Here's the most recent terminal context:\n" +
          sourceSnapshot.liveText +
          "\n=== End previous context ===\n";
      }
    }

    // Kill the old session
    debug(`migrating session ${sessionId} from ${sourceCwd} to ${targetWorktreePath}`, "session");
    session.kill();

    // Start new session in target worktree
    // If target is the main repo (cwd), pass undefined so it's not treated as a worktree
    const effectiveTarget = targetWorktreePath === process.cwd() ? undefined : targetWorktreePath;
    this.createSession(
      session.command,
      migrateArgs,
      useBackendResume ? undefined : toolCfg?.preambleFlag,
      toolConfigKey,
      historyContext.trim() || undefined,
      useBackendResume ? undefined : toolCfg?.sessionIdFlag,
      effectiveTarget,
      backendSessionId,
      sessionId,
    );
  }

  /** Get worktree path for a session */
  getSessionWorktreePath(sessionId: string): string | undefined {
    return this.sessionWorktreePaths.get(sessionId);
  }

  /** Get all sessions grouped by worktree path */
  getSessionsByWorktree(): Map<string | undefined, ManagedSession[]> {
    const groups = new Map<string | undefined, ManagedSession[]>();
    for (const session of this.sessions) {
      const wtPath = this.sessionWorktreePaths.get(session.id);
      const group = groups.get(wtPath) ?? [];
      group.push(session);
      groups.set(wtPath, group);
    }
    return groups;
  }

  private getScopedSessionEntries(): Array<{ session: ManagedSession; index: number }> {
    return this.sessions.map((session, index) => ({ session, index }));
  }

  private focusSession(index: number): void {
    if (index < 0 || index >= this.sessions.length) return;

    this.activeIndex = index;

    // Update MRU: move focused session to front
    const sid = this.sessions[index].id;
    this.sessionMRU = [sid, ...this.sessionMRU.filter((id) => id !== sid)];
    this.agentTracker.markSeen(sid);
    updateNotificationContext("tui", {
      focused: true,
      sessionId: sid,
      panelOpen: false,
    });
    this.noteLastUsedItem(sid);
    markNotificationsRead({ sessionId: sid });
    this.syncTuiNotificationContext(false);
    const target = this.sessionTmuxTargets.get(sid);
    if (target) {
      this.saveState();
      selectLinkedOrOpenTarget(this.tmuxRuntimeManager, target);
    }
  }

  private handleAction(action: HotkeyAction): void {
    switch (action.type) {
      case "dashboard":
        this.openTmuxDashboardTarget();
        break;

      case "help":
        this.showHelp();
        break;

      case "focus":
        if (action.index < this.getScopedSessionEntries().length) {
          this.focusSession(this.getScopedSessionEntries()[action.index].index);
        }
        break;

      case "next":
        if (this.getScopedSessionEntries().length > 1) {
          const scoped = this.getScopedSessionEntries();
          const currentPos = scoped.findIndex(({ index }) => index === this.activeIndex);
          if (currentPos >= 0) {
            this.focusSession(scoped[(currentPos + 1) % scoped.length].index);
          }
        }
        break;

      case "prev":
        if (this.getScopedSessionEntries().length > 1) {
          const scoped = this.getScopedSessionEntries();
          const currentPos = scoped.findIndex(({ index }) => index === this.activeIndex);
          if (currentPos >= 0) {
            this.focusSession(scoped[(currentPos - 1 + scoped.length) % scoped.length].index);
          }
        }
        break;

      case "create":
        this.showToolPicker();
        break;

      case "kill":
        if (this.sessions.length > 0) {
          const session = this.sessions[this.activeIndex];
          session.kill();
        }
        break;

      case "switcher":
        if (this.getScopedSessionEntries().length > 1) {
          this.showSwitcher();
        }
        break;

      case "worktree-create":
        this.showWorktreeCreatePrompt();
        break;

      case "worktree-list":
        this.showWorktreeList();
        break;

      case "review":
        this.handleReviewRequest();
        break;
    }
  }

  private handleDashboardKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;
    const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");
    const hasWorktrees = this.dashboardState.hasWorktrees();

    // Digits 1-9: always focus session directly (shortcut)
    if (key >= "1" && key <= "9") {
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

    // Keys that work at any level
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
      case "S": {
        this.showOrchestrationRoutePicker("message");
        return;
      }
      case "H": {
        this.showOrchestrationRoutePicker("handoff");
        return;
      }
      case "T": {
        this.showOrchestrationRoutePicker("task");
        return;
      }
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
        this.showNotificationPanel();
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
        // At worktree level, [x] removes the focused worktree
        if (hasWorktrees && this.dashboardState.level === "worktrees" && this.dashboardState.focusedWorktreePath) {
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
          ? allDs.find((d) => d.id === selId)
          : !hasWorktrees
            ? allDs[this.activeIndex]
            : undefined;
        if (!selEntry) return;

        const runtime = this.sessions.find((s) => s.id === selEntry.id);
        const effectivelyOffline =
          selEntry.status === "offline" ||
          selEntry.pendingAction === "stopping" ||
          !runtime ||
          !this.isSessionRuntimeLive(runtime);

        if (effectivelyOffline) {
          // Second [x] on offline → move to graveyard
          void this.graveyardSessionWithFeedback(selEntry.id, hasWorktrees);
          return;
        }
        // First [x] on running → stop PTY, keep as offline for resume
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
          ? allDs2.find((d) => d.id === selId2)
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
      // No worktrees — flat session navigation (simple mode)
      const totalCount = this.getDashboardSessions().length;
      switch (key) {
        case "down":
        case "j":
        case "n":
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
          if (entry?.pendingAction === "creating" || entry?.pendingAction === "starting") {
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
            const offline = this.offlineSessions.find((s) => s.id === entry.id);
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

    // Two-level navigation with worktrees
    if (this.dashboardState.level === "worktrees") {
      switch (key) {
        case "down":
        case "j":
        case "n": {
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
          // Step into worktree to navigate its sessions
          this.updateWorktreeSessions();
          if (this.dashboardState.worktreeEntries.length > 0) {
            this.dashboardState.level = "sessions";
            this.dashboardState.sessionIndex = 0;
            this.renderDashboard();
          }
          break;
        case "escape":
          // If a session exists, go back to focused agent view
          if (this.sessions.length > 0) {
            this.focusSession(this.activeIndex);
          }
          break;
      }
    } else {
      // Session level — navigating agents within a worktree
      switch (key) {
        case "down":
        case "j":
        case "n":
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
          const selectedEntry = this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex];
          if (!selectedEntry) break;
          if (selectedEntry.kind === "service") {
            const service = this.getDashboardServices().find((entry) => entry.id === selectedEntry.id);
            if (!service) break;
            if (service.pendingAction === "creating" || service.pendingAction === "starting") {
              return;
            }
            if (service.status === "offline") {
              try {
                this.resumeOfflineServiceById(service.id);
                this.footerFlash = `◆ Started service ${service.label ?? service.id}`;
                this.footerFlashTicks = 3;
                this.renderDashboard();
              } catch (error) {
                this.showDashboardError("Failed to start service", [
                  error instanceof Error ? error.message : String(error),
                ]);
              }
              return;
            }
            if (this.openLiveTmuxWindowForService(selectedEntry.id) !== "missing") {
              return;
            }
            break;
          }
          const dashEntry = this.dashboardState.worktreeSessions.find((entry) => entry.id === selectedEntry.id);
          if (!dashEntry) break;
          if (dashEntry.pendingAction === "creating" || dashEntry.pendingAction === "starting") {
            return;
          }
          if (this.openLiveTmuxWindowForEntry(dashEntry) !== "missing") {
            return;
          }
          if (dashEntry.remoteInstanceId) {
            void this.takeoverFromDashEntryWithFeedback(dashEntry);
            return;
          }
          if (dashEntry.status === "offline") {
            const offline = this.offlineSessions.find((s) => s.id === dashEntry.id);
            if (offline) {
              void this.resumeOfflineSessionWithFeedback(offline);
            }
            return;
          }
          // Focus live session
          const ptyIdx = this.sessions.findIndex((s) => s.id === dashEntry.id);
          if (ptyIdx >= 0) this.focusSession(ptyIdx);
          break;
        }
        case "escape":
        case "left":
        case "h":
          // Step back to worktree level
          this.dashboardState.level = "worktrees";
          this.renderDashboard();
          break;
      }
    }
  }

  private async activateDashboardEntryByNumber(index: number): Promise<void> {
    const entry = this.getDashboardSessionsInVisualOrder()[index];
    if (!entry) return;

    await this.activateDashboardEntry(entry);
  }

  private async activateDashboardEntry(entry: DashboardSession): Promise<void> {
    if (!entry) return;
    if (entry.pendingAction === "creating" || entry.pendingAction === "starting") {
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
      const offline = this.offlineSessions.find((session) => session.id === entry.id);
      if (offline) {
        await this.resumeOfflineSessionWithFeedback(offline);
      }
      return;
    }

    const ptyIdx = this.sessions.findIndex((session) => session.id === entry.id);
    if (ptyIdx >= 0) {
      this.noteLastUsedItem(entry.id);
      this.focusSession(ptyIdx);
    }
  }

  private attentionScore(entry: DashboardSession): number {
    return attentionScoreImpl(this, entry);
  }

  private getActivityEntries(): DashboardSession[] {
    return getActivityEntriesImpl(this);
  }

  private showActivityDashboard(): void {
    showActivityDashboardImpl(this);
  }

  private buildWorkflowEntries(): WorkflowEntry[] {
    return buildWorkflowEntriesForHostImpl(this);
  }

  private showWorkflow(): void {
    showWorkflowImpl(this);
  }

  private renderWorkflow(): void {
    renderWorkflowImpl(this);
  }

  private renderWorkflowDetails(width: number, height: number): string[] {
    return renderWorkflowDetailsForHostImpl(this, width, height);
  }

  private handleWorkflowKey(data: Buffer): void {
    handleWorkflowKeyImpl(this, data);
  }

  private renderActivityDashboard(): void {
    renderActivityDashboardImpl(this);
  }

  private handleActivityKey(data: Buffer): void {
    handleActivityKeyImpl(this, data);
  }

  private showThreads(): void {
    showThreadsImpl(this);
  }

  private getPreferredThreadIndexForParticipant(participantId: string, entries: ThreadEntry[]): number {
    return getPreferredThreadIndexForParticipantImpl(this, participantId, entries);
  }

  private openRelevantThreadForSession(sessionId: string): void {
    openRelevantThreadForSessionImpl(this, sessionId);
  }

  private renderThreads(): void {
    renderThreadsImpl(this);
  }

  private renderThreadDetails(width: number, height: number): string[] {
    return renderThreadDetailsForHostImpl(this, width, height);
  }

  private handleThreadsKey(data: Buffer): void {
    handleThreadsKeyImpl(this, data);
  }

  private renderThreadReply(): void {
    renderThreadReplyImpl(this);
  }

  private describeHandoffState(thread: OrchestrationThread): string {
    return describeHandoffStateImpl(this, thread);
  }

  private async runThreadHandoffAction(mode: "accept" | "complete", threadId: string): Promise<void> {
    await runThreadHandoffActionImpl(this, mode, threadId);
  }

  private async runThreadStatusAction(threadId: string, status: ThreadStatus): Promise<void> {
    await runThreadStatusActionImpl(this, threadId, status);
  }

  private async runTaskLifecycleAction(
    mode: "accept" | "block" | "complete" | "reopen",
    taskId: string,
  ): Promise<void> {
    await runTaskLifecycleActionImpl(this, mode, taskId);
  }

  private async runReviewLifecycleAction(mode: "approve" | "request_changes", taskId: string): Promise<void> {
    await runReviewLifecycleActionImpl(this, mode, taskId);
  }

  private describeWorkflowFilter(): string {
    return describeWorkflowFilterImpl(this);
  }

  private cycleWorkflowFilter(): void {
    cycleWorkflowFilterImpl(this);
  }

  private handleThreadReplyKey(data: Buffer): void {
    handleThreadReplyKeyImpl(this, data);
  }

  private async activateNextAttentionEntry(): Promise<void> {
    await activateNextAttentionEntryImpl(this);
  }

  /** Get sessions belonging to the focused worktree (includes local, remote, offline) */
  private updateWorktreeSessions(): void {
    updateWorktreeSessionsImpl(this);
  }

  private syncTuiNotificationContext(panelOpen = false): void {
    syncTuiNotificationContextImpl(this, panelOpen);
  }

  private isDashboardScreen(screen: DashboardScreen): boolean {
    return isDashboardScreenImpl(this, screen);
  }

  private setDashboardScreen(screen: DashboardScreen): void {
    setDashboardScreenImpl(this, screen);
  }

  private handleActiveDashboardOverlayKey(data: Buffer): boolean {
    return handleActiveDashboardOverlayKeyImpl(this, data);
  }

  private renderActiveDashboardOverlay(): boolean {
    return renderActiveDashboardOverlayImpl(this);
  }

  private handleDashboardSubscreenNavigationKey(
    key: string,
    currentScreen: Exclude<DashboardScreen, "dashboard">,
  ): boolean {
    return handleDashboardSubscreenNavigationKeyImpl(this, key, currentScreen);
  }

  private openLiveTmuxWindowForEntry(entry: { id: string; backendSessionId?: string }): "opened" | "missing" | "error" {
    return openLiveTmuxWindowForEntryImpl(this, entry);
  }

  private openLiveTmuxWindowForService(serviceId: string): "opened" | "missing" | "error" {
    return openLiveTmuxWindowForServiceImpl(this, serviceId);
  }

  private noteLastUsedItem(itemId: string): void {
    noteLastUsedItemImpl(this, itemId);
  }

  private getSelectedDashboardWorktreeEntry(): DashboardWorktreeEntry | undefined {
    return getSelectedDashboardWorktreeEntryImpl(this);
  }

  private getSelectedDashboardSessionForActions(): DashboardSession | undefined {
    return getSelectedDashboardSessionForActionsImpl(this);
  }

  private getSelectedDashboardServiceForActions(): DashboardService | undefined {
    return getSelectedDashboardServiceForActionsImpl(this);
  }

  private showOrchestrationRoutePicker(mode: "message" | "handoff" | "task"): void {
    showOrchestrationRoutePickerImpl(this, mode);
  }

  private showOrchestrationInput(mode: "message" | "handoff" | "task", target: DashboardOrchestrationTarget): void {
    showOrchestrationInputImpl(this, mode, target);
  }

  private renderOrchestrationInput(): void {
    renderOrchestrationInputImpl(this);
  }

  private renderOrchestrationRoutePicker(): void {
    renderOrchestrationRoutePickerImpl(this);
  }

  private formatRoutePreview(recipientIds: string[]): string {
    if (recipientIds.length === 0) return "";
    const preview = recipientIds.slice(0, 2).join(", ");
    const remainder = recipientIds.length > 2 ? `, +${recipientIds.length - 2}` : "";
    return ` [${recipientIds.length}: ${preview}${remainder}]`;
  }

  private async postToProjectService(path: string, body: unknown): Promise<any> {
    return postToProjectServiceImpl(this, path, body);
  }

  private async ensureDashboardControlPlane(): Promise<void> {
    await ensureDashboardControlPlaneImpl(this);
  }

  private handleOrchestrationInputKey(data: Buffer): void {
    handleOrchestrationInputKeyImpl(this, data);
  }

  private handleOrchestrationRoutePickerKey(data: Buffer): void {
    handleOrchestrationRoutePickerKeyImpl(this, data);
  }

  private async submitDashboardOrchestrationAction(
    mode: "message" | "handoff" | "task",
    target: DashboardOrchestrationTarget,
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
        this.footerFlash =
          count > 1 ? `✉ Message sent → ${count} agents via ${target.label}` : `✉ Message sent → ${target.label}`;
      } else if (mode === "handoff") {
        await this.postToProjectService("/handoff", {
          ...requestBody,
          body,
          title: `Handoff to ${target.label}`,
        });
        const count = target.sessionId ? 1 : (target.recipientIds?.length ?? 0);
        this.footerFlash =
          count > 1 ? `⇢ Handoff sent → ${count} agents via ${target.label}` : `⇢ Handoff sent → ${target.label}`;
      } else {
        await this.postToProjectService("/tasks/assign", {
          from: "user",
          to: target.sessionId,
          assignee: target.assignee,
          tool: target.tool,
          worktreePath: target.worktreePath,
          description: body,
        });
        this.footerFlash = `⧫ Task assigned → ${target.label}`;
      }
      this.footerFlashTicks = 3;
    } catch {
      try {
        const metadataState = loadMetadataState().sessions;
        const localRecipients = target.sessionId
          ? [target.sessionId]
          : resolveOrchestrationRecipients({
              candidates: this.sessions.map((session) => ({
                id: session.id,
                tool: this.sessionToolKeys.get(session.id) ?? session.command,
                role: this.sessionRoles.get(session.id),
                worktreePath: this.sessionWorktreePaths.get(session.id),
                status: metadataState[session.id]?.derived?.activity,
                availability: this.deriveSessionSemanticState(
                  session.id,
                  metadataState[session.id]?.derived?.activity === "running"
                    ? "running"
                    : metadataState[session.id]?.derived?.activity === "waiting"
                      ? "waiting"
                      : session.status,
                ).availability,
                workflowPressure: this.orchestrationWorkflowPressure(
                  session.id,
                  metadataState[session.id]?.derived?.activity === "running"
                    ? "running"
                    : metadataState[session.id]?.derived?.activity === "waiting"
                      ? "waiting"
                      : session.status,
                ),
                exited: session.exited,
              })),
              assignee: target.assignee,
              tool: target.tool,
              worktreePath: target.worktreePath,
            });
        if (localRecipients.length === 0) {
          throw new Error("no matching live session for selected route");
        }
        if (mode === "message") {
          this.sendOrchestrationMessage({
            from: "user",
            to: localRecipients,
            kind: "request",
            body,
          });
          this.footerFlash =
            localRecipients.length > 1
              ? `✉ Message sent → ${localRecipients.length} agents via ${target.label}`
              : `✉ Message sent → ${target.label}`;
        } else if (mode === "handoff") {
          this.sendHandoffMessage({
            from: "user",
            to: localRecipients,
            body,
            title: `Handoff to ${target.label}`,
          });
          this.footerFlash =
            localRecipients.length > 1
              ? `⇢ Handoff sent → ${localRecipients.length} agents via ${target.label}`
              : `⇢ Handoff sent → ${target.label}`;
        } else {
          await assignTask({
            from: "user",
            to: localRecipients[0],
            assignee: target.assignee,
            tool: target.tool,
            worktreePath: target.worktreePath,
            description: body,
          });
          this.footerFlash = `⧫ Task assigned → ${target.label}`;
        }
        this.footerFlashTicks = 3;
      } catch (error) {
        this.showDashboardError(
          `Failed to ${mode === "task" ? "assign task" : mode === "handoff" ? "send handoff" : "send message"}`,
          [error instanceof Error ? error.message : String(error)],
        );
        return;
      }
    }
    this.renderDashboard();
  }

  private renderToolPicker(): void {
    renderToolPickerImpl(this);
  }

  private runSelectedTool(toolKey: string, tool: any): void {
    runSelectedToolImpl(this, toolKey, tool);
  }

  private showToolPicker(sourceSessionId?: string): void {
    showToolPickerImpl(this, sourceSessionId);
  }

  private handleToolPickerKey(data: Buffer): void {
    handleToolPickerKeyImpl(this, data);
  }

  private async forkSessionFromSource(
    sourceSessionId: string,
    targetToolConfigKey: string,
    instruction?: string,
    targetWorktreePath?: string,
  ): Promise<{ sessionId: string; threadId: string; target?: TmuxTarget } | undefined> {
    const sourceSession = this.sessions.find((session) => session.id === sourceSessionId);
    if (!sourceSession) {
      this.showDashboardError("Cannot fork missing session", [`Source session ${sourceSessionId} not found.`]);
      return undefined;
    }
    const config = loadConfig();
    const toolCfg = config.tools[targetToolConfigKey];
    if (!toolCfg) {
      this.showDashboardError("Cannot fork session", [`Unknown tool config: ${targetToolConfigKey}`]);
      return undefined;
    }
    const targetSessionId = `${toolCfg.command}-${Math.random().toString(36).slice(2, 8)}`;
    const targetWorktree =
      targetWorktreePath === process.cwd()
        ? undefined
        : (targetWorktreePath ?? this.sessionWorktreePaths.get(sourceSessionId));
    const thread = createThread({
      title: `Handoff: ${this.getSessionLabel(sourceSessionId) ?? sourceSession.command} → ${toolCfg.command}`,
      kind: "handoff",
      createdBy: sourceSessionId,
      participants: [sourceSessionId, targetSessionId],
      owner: targetSessionId,
      waitingOn: [targetSessionId],
      worktreePath: targetWorktree,
    });
    const handoffBody = instruction?.trim() || "Continue this work with the same context and take over as needed.";
    appendMessage(thread.id, {
      from: sourceSessionId,
      to: [targetSessionId],
      kind: "handoff",
      body: handoffBody,
      metadata: {
        sourceSessionId,
      },
    });
    updateThread(thread.id, (current) => ({
      ...current,
      status: "waiting",
      owner: targetSessionId,
      waitingOn: [targetSessionId],
    }));
    await this.contextWatcher.syncNow(sourceSessionId).catch(() => {});
    const sourceSnapshot = this.sessionBootstrap.readForkSourceSnapshot(sourceSessionId);
    this.sessionBootstrap.seedForkArtifacts(sourceSessionId, targetSessionId, targetToolConfigKey);
    const extraPreamble = [
      this.sessionBootstrap.buildForkPreamble(sourceSessionId, targetSessionId),
      instruction?.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");
    const transport = this.createSession(
      toolCfg.command,
      toolCfg.args,
      toolCfg.preambleFlag,
      targetToolConfigKey,
      extraPreamble,
      toolCfg.sessionIdFlag,
      targetWorktree,
      undefined,
      targetSessionId,
      !toolCfg.preambleFlag,
    );
    if (!toolCfg.preambleFlag) {
      const kickoff = this.sessionBootstrap.buildForkKickoffPrompt(
        sourceSessionId,
        targetSessionId,
        sourceSnapshot,
        instruction,
      );
      await new Promise<void>((resolve) => {
        setTimeout(async () => {
          try {
            const target = this.sessionTmuxTargets.get(targetSessionId);
            debug(
              `fork kickoff: source=${sourceSessionId} target=${targetSessionId} toolKey=${targetToolConfigKey} targetFound=${target ? "yes" : "no"} kickoffPreview=${JSON.stringify(kickoff.slice(0, 220))}`,
              "fork",
            );
            if (target) {
              this.tmuxRuntimeManager.sendText(target, kickoff);
              await this.sessionBootstrap.waitForCodexKickoffSubmit(targetSessionId, target, kickoff);
            } else {
              debug(
                `fork kickoff fallback transport write: target=${targetSessionId} toolKey=${targetToolConfigKey}`,
                "fork",
              );
              transport.write(kickoff + "\r");
            }
          } catch {
            // Continue even if kickoff automation fails; user can still recover manually.
          } finally {
            resolve();
          }
        }, 1800);
      });
    }
    this.agentTracker.emit(sourceSessionId, {
      kind: "status",
      message: `Forked ${targetSessionId} from this session`,
      threadId: thread.id,
      threadName: thread.title,
      source: "fork",
      tone: "info",
    });
    this.agentTracker.emit(targetSessionId, {
      kind: "task_assigned",
      message: `Forked from ${sourceSessionId}`,
      threadId: thread.id,
      threadName: thread.title,
      source: "fork",
      tone: "info",
    });
    return {
      sessionId: targetSessionId,
      threadId: thread.id,
      target: this.sessionTmuxTargets.get(transport.id),
    };
  }

  async forkAgent(opts: {
    sourceSessionId: string;
    targetToolConfigKey: string;
    instruction?: string;
    targetWorktreePath?: string;
    open?: boolean;
  }): Promise<{ sessionId: string; threadId: string }> {
    return forkAgentImpl(this, opts);
  }

  async spawnAgent(opts: {
    toolConfigKey: string;
    targetWorktreePath?: string;
    open?: boolean;
  }): Promise<{ sessionId: string }> {
    return spawnAgentImpl(this, opts);
  }

  async renameAgent(sessionId: string, label?: string): Promise<{ sessionId: string; label?: string }> {
    return renameAgentImpl(this, sessionId, label);
  }

  async stopAgent(sessionId: string): Promise<{ sessionId: string; status: "offline" }> {
    return stopAgentImpl(this, sessionId);
  }

  async sendAgentToGraveyard(sessionId: string): Promise<{
    sessionId: string;
    status: "graveyard";
    previousStatus: "running" | "offline";
  }> {
    return sendAgentToGraveyardImpl(this, sessionId);
  }

  async migrateAgentSession(
    sessionId: string,
    targetWorktreePath: string,
  ): Promise<{ sessionId: string; worktreePath?: string }> {
    return migrateAgentSessionImpl(this, sessionId, targetWorktreePath);
  }

  private serviceLabelForCommand(commandLine: string): string {
    return serviceLabelForCommandImpl(commandLine);
  }

  private generateDashboardSessionId(command: string): string {
    return `${command}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private settleDashboardCreatePending(itemId: string): void {
    if (!(this.startedInDashboard && this.mode === "dashboard")) return;
    this.dashboardPendingActions.settleCreatePending(itemId, () => {
      this.refreshLocalDashboardModel();
      this.renderDashboard();
    });
  }

  private preferDashboardEntrySelection(kind: "session" | "service", id: string, worktreePath?: string): void {
    if (!(this.startedInDashboard && this.mode === "dashboard")) return;
    this.dashboardUiStateStore.preferEntrySelection(this.dashboardState, kind, id, worktreePath);
  }

  private createService(commandLine: string, worktreePath?: string): { serviceId: string } {
    return createServiceImpl(this, commandLine, worktreePath);
  }

  private stopService(serviceId: string): { serviceId: string; status: "stopped" } {
    return stopServiceImpl(this, serviceId);
  }

  private removeOfflineService(serviceId: string): { serviceId: string; status: "removed" } {
    return removeOfflineServiceImpl(this, serviceId);
  }

  private resumeOfflineService(service: ServiceState): { serviceId: string; status: "running" } {
    return resumeOfflineServiceImpl(this, service);
  }

  private resumeOfflineServiceById(serviceId: string): { serviceId: string; status: "running" } {
    return resumeOfflineServiceByIdImpl(this, serviceId);
  }

  private renderDashboard(): void {
    this.writeStatuslineFile();

    const { cols, rows } = this.getViewportSize();
    const dashSessions = this.dashboardSessionsCache;
    const dashServices = this.dashboardServicesCache;
    const worktreeGroups = this.dashboardWorktreeGroupsCache;
    const mainCheckoutInfo = this.dashboardMainCheckoutInfoCache;

    // Build worktree navigation order: main repo first, then registered worktrees
    const hasWorktrees = worktreeGroups.length > 0;
    this.dashboardState.worktreeNavOrder = [undefined, ...worktreeGroups.map((wt) => wt.path)];
    // Ensure focusedWorktreePath is valid
    if (!this.dashboardState.worktreeNavOrder.includes(this.dashboardState.focusedWorktreePath)) {
      this.dashboardState.focusedWorktreePath = undefined;
      this.dashboardUiStateStore.markSelectionDirty();
    }
    this.restoreDashboardSelectionFromPreference(dashSessions, hasWorktrees);

    // Determine selected session for cursor
    let selectedSession: string | undefined;
    let selectedService: string | undefined;

    // Determine selected session cursor
    if (hasWorktrees && this.dashboardState.level === "sessions" && this.dashboardState.worktreeEntries.length > 0) {
      const selectedEntry = this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex];
      if (selectedEntry?.kind === "session") selectedSession = selectedEntry.id;
      if (selectedEntry?.kind === "service") selectedService = selectedEntry.id;
    } else if (!hasWorktrees && dashSessions.length > 0) {
      // Flat mode — use activeIndex across all dash sessions
      selectedSession = dashSessions[this.activeIndex]?.id;
    }

    this.dashboard.update(
      dashSessions,
      dashServices,
      worktreeGroups,
      this.dashboardState.focusedWorktreePath,
      hasWorktrees ? this.dashboardState.level : "sessions",
      selectedSession,
      selectedService,
      "tmux",
      mainCheckoutInfo,
    );
    this.syncTuiNotificationContext(Boolean(this.notificationPanelState));
    this.writeFrame(this.dashboard.render(cols, rows));
    this.persistDashboardUiState();
    if (this.dashboardBusyState) {
      this.renderDashboardBusyOverlay();
    } else if (this.dashboardErrorState) {
      this.renderDashboardErrorOverlay();
    }
  }

  private showWorktreeCreatePrompt(): void {
    showWorktreeCreatePromptImpl(this);
  }

  private showServiceCreatePrompt(): void {
    this.serviceInputActive = true;
    this.serviceInputBuffer = "";
    this.renderServiceInput();
  }

  private renderWorktreeInput(): void {
    renderWorktreeInputImpl(this);
  }

  private renderServiceInput(): void {
    renderServiceInputOverlay(this);
  }

  private handleWorktreeInputKey(data: Buffer): void {
    handleWorktreeInputKeyImpl(this, data);
  }

  private handleServiceInputKey(data: Buffer): void {
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
  }

  private renderLabelInput(): void {
    renderLabelInputOverlay(this);
  }

  private handleLabelInputKey(data: Buffer): void {
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

    // Append printable character
    if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
      this.labelInputBuffer += event.char;
      this.renderLabelInput();
    }
  }

  private showWorktreeList(): void {
    showWorktreeListImpl(this);
  }

  private handleReviewRequest(): void {
    const session = this.activeSession;
    if (!session) return;

    const role = this.sessionRoles.get(session.id) ?? "coder";

    // Try to get a recent git diff for the review
    let diff: string | undefined;
    try {
      diff = execSync("git diff HEAD", { encoding: "utf-8", timeout: 5000 }).slice(0, 5000) || undefined;
    } catch {}

    const reviewTask = requestReview(session.id, role, diff, `Review ${session.command} agent's recent work`);

    if (reviewTask) {
      this.footerFlash = `⧫ Review requested → ${reviewTask.assignee ?? "reviewer"}`;
      this.footerFlashTicks = 3;
    } else {
      this.footerFlash = `No reviewer role configured`;
      this.footerFlashTicks = 3;
    }
  }

  private renderWorktreeList(): void {
    renderWorktreeListImpl(this);
  }

  private renderWorktreeRemoveConfirm(): void {
    renderWorktreeRemoveConfirmImpl(this);
  }

  private renderDashboardBusyOverlay(): void {
    renderDashboardBusyOverlay(this);
  }

  private renderDashboardErrorOverlay(): void {
    renderDashboardErrorOverlay(this);
  }

  private showNotificationPanel(): void {
    showNotificationPanelImpl(this);
  }

  private closeNotificationPanel(): void {
    closeNotificationPanelImpl(this);
  }

  private renderNotificationPanel(): void {
    renderNotificationPanel(this);
  }

  private handleNotificationPanelKey(data: Buffer): void {
    handleNotificationPanelKeyImpl(this, data);
  }

  private startDashboardBusy(title: string, lines: string[]): void {
    this.dashboardFeedback.startBusy(title, lines);
  }

  private updateDashboardBusy(lines: string[]): void {
    this.dashboardFeedback.updateBusy(lines);
  }

  private clearDashboardBusy(): void {
    this.dashboardFeedback.clearBusy();
  }

  private showDashboardError(title: string, lines: string[]): void {
    this.dashboardFeedback.showError(title, lines);
  }

  private dismissDashboardError(): void {
    this.dashboardFeedback.dismissError();
  }

  private beginWorktreeRemoval(path: string, name: string, oldIdx: number): void {
    beginWorktreeRemovalImpl(this, path, name, oldIdx);
  }

  private finishWorktreeRemoval(code: number): void {
    finishWorktreeRemovalImpl(this, code);
  }

  private handleWorktreeRemoveConfirmKey(data: Buffer): void {
    handleWorktreeRemoveConfirmKeyImpl(this, data);
  }

  private handleWorktreeListKey(data: Buffer): void {
    handleWorktreeListKeyImpl(this, data);
  }

  private showGraveyard(): void {
    showGraveyardImpl(this);
  }

  private renderGraveyard(): void {
    renderGraveyardImpl(this);
  }

  private handleGraveyardKey(data: Buffer): void {
    handleGraveyardKeyImpl(this, data);
  }

  private resurrectGraveyardEntry(idx: number): void {
    resurrectGraveyardEntryImpl(this, idx);
  }

  private showPlans(): void {
    showPlansImpl(this);
  }

  private loadPlanEntries(): void {
    loadPlanEntriesImpl(this);
  }

  private parsePlanFrontmatter(content: string): Record<string, string> {
    return parsePlanFrontmatterImpl(content);
  }

  private renderPlans(): void {
    renderPlansImpl(this);
  }

  private buildPlanPreview(content: string, width: number, maxLines: number): string[] {
    return buildPlanPreviewImpl(content, width, maxLines);
  }

  private renderPlanDetails(width: number, height: number): string[] {
    return renderPlanDetailsForHostImpl(this, width, height);
  }

  private renderGraveyardDetails(width: number, height: number): string[] {
    return renderGraveyardDetailsForHostImpl(this, width, height);
  }

  private handlePlansKey(data: Buffer): void {
    handlePlansKeyImpl(this, data);
  }

  private openPlanInEditor(path: string): void {
    openPlanInEditorImpl(this, path);
  }

  // --- Quick Switcher (^A s) ---

  /** Get sessions in MRU order (most recently used first), only running/alive sessions */
  private getSwitcherList(): ManagedSession[] {
    return getSwitcherListImpl(this);
  }

  private showSwitcher(): void {
    showSwitcherImpl(this);
  }

  private resetSwitcherTimeout(): void {
    resetSwitcherTimeoutImpl(this);
  }

  private confirmSwitcher(): void {
    confirmSwitcherImpl(this);
  }

  private dismissSwitcher(): void {
    dismissSwitcherImpl(this);
  }

  private redrawCurrentView(): void {
    redrawCurrentViewImpl(this);
  }

  private showHelp(): void {
    showHelpImpl(this);
  }

  private dismissHelp(): void {
    dismissHelpImpl(this);
  }

  private renderHelp(): void {
    renderHelpImpl(this);
  }

  private handleHelpKey(data: Buffer): void {
    handleHelpKeyImpl(this, data);
  }

  private renderSwitcher(): void {
    renderSwitcherImpl(this);
  }

  private handleSwitcherKey(data: Buffer): void {
    handleSwitcherKeyImpl(this, data);
  }

  private showMigratePicker(): void {
    showMigratePickerImpl(this);
  }

  private renderMigratePicker(): void {
    renderMigratePickerImpl(this);
  }

  private async runDashboardOperation<T>(
    title: string,
    lines: string[],
    work: () => Promise<T> | T,
    errorTitle = title,
  ): Promise<T | undefined> {
    return runDashboardOperationImpl(this, title, lines, work, errorTitle);
  }

  private setPendingDashboardSessionAction(sessionId: string, kind: PendingDashboardActionKind | null): void {
    setPendingDashboardSessionActionImpl(this, sessionId, kind);
  }

  private async stopSessionToOfflineWithFeedback(session: ManagedSession): Promise<void> {
    await stopSessionToOfflineWithFeedbackImpl(this, session);
  }

  private clearDashboardSubscreens(): void {
    clearDashboardSubscreensImpl(this);
  }

  private renderSessionDetails(session: DashboardSession | undefined, width: number, height: number): string[] {
    return renderSessionDetailsImpl(this, session, width, height);
  }

  private composeSplitScreen(
    leftLines: string[],
    rightLines: string[],
    cols: number,
    viewportHeight: number,
    focusLine: number,
    twoPane: boolean,
  ): string[] {
    return composeSplitScreenImpl(this, leftLines, rightLines, cols, viewportHeight, focusLine, twoPane);
  }

  private composeTwoPaneLines(left: string[], right: string[], cols: number): string[] {
    return composeTwoPaneLinesImpl(left, right, cols);
  }

  private wrapKeyValue(key: string, value: string, width: number): string[] {
    return wrapKeyValueForHost(key, value, width);
  }

  private wrapText(text: string, width: number): string[] {
    return wrapTextForHost(text, width);
  }

  private truncatePlain(text: string, max: number): string {
    return truncatePlainForHost(text, max);
  }

  private truncateAnsi(text: string, max: number): string {
    return truncateAnsiForHost(text, max);
  }

  private basename(value: string): string {
    return basenameForHost(value);
  }

  private listAllWorktrees(): Array<{ name: string; branch: string; path: string; isBare: boolean }> {
    return listAllWorktrees();
  }

  private async graveyardSessionWithFeedback(sessionId: string, hasWorktrees: boolean): Promise<void> {
    await graveyardSessionWithFeedbackImpl(this, sessionId, hasWorktrees);
  }

  private async resumeOfflineSessionWithFeedback(session: SessionState): Promise<void> {
    await resumeOfflineSessionWithFeedbackImpl(this, session);
  }

  private async waitForSessionStart(sessionId: string, timeoutMs = 8000): Promise<boolean> {
    return waitForSessionStartForHost(this, sessionId, timeoutMs);
  }

  private dashboardSessionActionDeps() {
    return dashboardSessionActionDepsImpl(this);
  }

  private async takeoverFromDashEntryWithFeedback(entry: DashboardSession): Promise<void> {
    await takeoverFromDashEntryWithFeedbackImpl(this, entry);
  }

  private async migrateSessionWithFeedback(
    session: ManagedSession,
    targetPath: string,
    targetName: string,
  ): Promise<void> {
    await migrateSessionWithFeedbackImpl(this, session, targetPath, targetName);
  }

  private handleMigratePickerKey(data: Buffer): void {
    handleMigratePickerKeyImpl(this, data);
  }

  /** Get the current dashboard sessions (local + remote merged) for lookup */
  private getDashboardSessions(): DashboardSession[] {
    return this.mode === "dashboard" ? this.dashboardSessionsCache : this.computeDashboardSessions();
  }

  private getDashboardServices(): DashboardService[] {
    return this.mode === "dashboard" ? this.dashboardServicesCache : this.computeDashboardServices();
  }

  private getDashboardSessionsInVisualOrder(): DashboardSession[] {
    const allDash = this.getDashboardSessions();
    if (this.mode === "dashboard") {
      const mainSessions = allDash.filter((session) => !session.worktreePath);
      const ordered = [...mainSessions];
      const seen = new Set(mainSessions.map((session) => session.id));
      for (const group of this.dashboardWorktreeGroupsCache) {
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
  }

  /** Take over a remote session from a DashboardSession entry */
  private async takeoverSessionFromDashEntry(entry: DashboardSession): Promise<void> {
    if (!entry.remoteInstanceId || !entry.remoteBackendSessionId) return;
    await this.takeoverSession({
      id: entry.id,
      tool: entry.command,
      backendSessionId: entry.remoteBackendSessionId,
      fromInstanceId: entry.remoteInstanceId,
    });
  }

  private async takeoverSession(target: {
    id: string;
    tool: string;
    backendSessionId: string;
    fromInstanceId: string;
  }): Promise<void> {
    // Claim the session from the other instance
    const claimed = await this.instanceDirectory.claimSession(target.id, target.fromInstanceId, process.cwd());
    if (!claimed) {
      debug(`takeover: session ${target.id} not found in instance ${target.fromInstanceId}`, "instance");
      return;
    }

    // Find the tool config for the claimed session's tool
    const config = loadConfig();
    const toolEntry = Object.entries(config.tools).find(([, t]) => t.command === target.tool);
    const toolCfg = toolEntry?.[1];
    const toolConfigKey = toolEntry?.[0];

    if (!toolCfg?.resumeArgs) {
      debug(`takeover: no resumeArgs configured for tool ${target.tool}`, "instance");
      return;
    }
    if (!this.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, target.backendSessionId)) {
      debug(`takeover: tool ${target.tool} does not support backendSessionId resume`, "instance");
      return;
    }

    // Build resume args with the backend session ID
    const resumeArgs = toolCfg.resumeArgs.map((a: string) => a.replace("{sessionId}", target.backendSessionId));
    const args = this.sessionBootstrap.composeToolArgs(toolCfg, resumeArgs);

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
  }

  /** Instruction files we've written (to clean up on exit) */
  private writtenInstructionFiles = new Set<string>();

  /** Write tool instruction files (e.g. CODEX.md) for tools that don't support --append-system-prompt */
  private writeInstructionFiles(): void {
    const config = loadConfig();
    const preamble =
      "# aimux Agent Instructions\n\n" +
      "You are running inside aimux, an agent multiplexer. " +
      "Other agents may be working on this codebase simultaneously.\n\n" +
      "## Context Files\n" +
      "- `.aimux/context/{session-id}/live.md` — each agent's recent conversation\n" +
      "- `.aimux/context/{session-id}/summary.md` — each agent's compacted history\n" +
      "- `.aimux/sessions.json` — all running agents (use to find other agents' session IDs)\n" +
      "- `.aimux/history/` — full raw conversation history (JSONL)\n\n" +
      "Check sessions.json to discover other agents, then read their context files.\n" +
      "This file is auto-generated by aimux and will be removed when aimux exits.\n";

    // Append user preamble from AIMUX.md: global (~/) then project (./)
    let fullPreamble = preamble;
    for (const mdPath of [join(homedir(), "AIMUX.md"), join(process.cwd(), "AIMUX.md")]) {
      if (existsSync(mdPath)) {
        try {
          const userContent = readFileSync(mdPath, "utf-8").trim();
          if (userContent) {
            fullPreamble += "\n## User Instructions\n\n" + userContent + "\n";
            debug(`loaded ${mdPath} for instructions file (${userContent.length} chars)`, "preamble");
          }
        } catch {}
      }
    }

    for (const [, tool] of Object.entries(config.tools)) {
      if (!tool.instructionsFile || !tool.enabled) continue;
      const filePath = join(process.cwd(), tool.instructionsFile);
      // Don't overwrite if it already exists and wasn't written by us
      if (existsSync(filePath) && !this.writtenInstructionFiles.has(filePath)) {
        debug(`skipping ${tool.instructionsFile} — already exists`, "context");
        continue;
      }
      writeFileSync(filePath, fullPreamble);
      this.writtenInstructionFiles.add(filePath);
      debug(`wrote ${tool.instructionsFile}`, "context");
    }
  }

  /** Remove instruction files we created */
  private removeInstructionFiles(): void {
    for (const filePath of this.writtenInstructionFiles) {
      try {
        unlinkSync(filePath);
      } catch {}
    }
    this.writtenInstructionFiles.clear();
  }

  private writeSessionsFile(): void {
    const dir = getLocalAimuxDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const localSessions = this.sessions.map((s) => ({
      id: s.id,
      tool: s.command,
      backendSessionId: s.backendSessionId,
      worktreePath: this.sessionWorktreePaths.get(s.id),
    }));
    const data = this.instanceDirectory.buildSessionsFileEntries(
      localSessions,
      this.instanceDirectory.getRemoteInstancesSafe(this.instanceId, process.cwd()),
    );

    writeFileSync(`${dir}/sessions.json`, JSON.stringify(data, null, 2) + "\n");
  }

  /** Write statusline state for Claude Code's statusline script to read */
  private writeStatuslineFile(): void {
    try {
      if (this.mode !== "project-service") return;
      for (const session of this.sessions) {
        this.syncTmuxWindowMetadata(session.id);
      }
      this.refreshDesktopStateSnapshot();
      const dir = getProjectStateDir();
      const filePath = join(dir, "statusline.json");
      const tmpPath = `${filePath}.tmp`;
      const data = this.buildStatuslineSnapshot();
      const { updatedAt: _updatedAt, ...stableData } = data;
      const snapshotKey = JSON.stringify(stableData);
      if (snapshotKey === this.lastStatuslineSnapshotKey) {
        return;
      }
      this.lastStatuslineSnapshotKey = snapshotKey;
      writeFileSync(tmpPath, JSON.stringify(data) + "\n");
      renameSync(tmpPath, filePath);
      this.writePrecomputedTmuxStatuslineFiles(data);
      this.tmuxRuntimeManager.refreshStatus();
    } catch {}
  }

  private getTmuxStatuslineDir(): string {
    const dir = join(getProjectStateDir(), "tmux-statusline");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private writeStatuslineTextFile(name: string, content: string): void {
    const dir = this.getTmuxStatuslineDir();
    const filePath = join(dir, name);
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, `${content}\n`);
    renameSync(tmpPath, filePath);
  }

  private writePrecomputedTmuxStatuslineFiles(data: ReturnType<Multiplexer["buildStatuslineSnapshot"]>): void {
    const dashboardTop = renderTmuxStatuslineFromData(data, process.cwd(), "top", {
      currentWindow: "dashboard",
      currentPath: process.cwd(),
    });
    const dashboardBottom = renderTmuxStatuslineFromData(data, process.cwd(), "bottom", {
      currentWindow: "dashboard",
      currentPath: process.cwd(),
    });
    this.writeStatuslineTextFile("top-dashboard.txt", dashboardTop);
    this.writeStatuslineTextFile("bottom-dashboard.txt", dashboardBottom);

    for (const entry of data.sessions) {
      if (!entry.tmuxWindowId) continue;
      const renderOptions = {
        currentWindow: entry.windowName,
        currentWindowId: entry.tmuxWindowId,
        currentPath: entry.worktreePath ?? process.cwd(),
      };
      const top = renderTmuxStatuslineFromData(data, process.cwd(), "top", renderOptions);
      const bottom = renderTmuxStatuslineFromData(data, process.cwd(), "bottom", renderOptions);
      this.writeStatuslineTextFile(`top-${entry.tmuxWindowId}.txt`, top);
      this.writeStatuslineTextFile(`bottom-${entry.tmuxWindowId}.txt`, bottom);
    }
  }

  private writeDashboardClientStatuslineFile(): void {
    if (this.mode !== "dashboard") return;
    const clientSession = this.tmuxRuntimeManager.currentClientSession();
    if (!clientSession) return;
    const localData = loadStatusline(process.cwd()) ?? {
      project: basename(process.cwd()),
      sessions: [],
      metadata: {},
      tasks: { pending: 0, assigned: 0 },
      controlPlane: { daemonAlive: true, projectServiceAlive: false },
      flash: null,
      updatedAt: new Date().toISOString(),
    };
    const data = { ...localData, dashboardScreen: this.dashboardState.screen };
    const bottom = renderTmuxStatuslineFromData(data, process.cwd(), "bottom", {
      currentSession: clientSession,
      currentWindow: this.tmuxRuntimeManager.displayMessage("#{window_name}") ?? "dashboard",
      currentPath: process.cwd(),
    });
    this.writeStatuslineTextFile(`bottom-dashboard-${clientSession}.txt`, bottom);
  }

  private buildStatuslineSnapshot(): {
    project: string;
    dashboardScreen: DashboardScreen;
    sessions: Array<{
      id: string;
      kind?: "agent" | "service";
      tool: string;
      label?: string;
      tmuxWindowId?: string;
      tmuxWindowIndex?: number;
      windowName: string;
      headline?: string;
      status: string;
      role?: string;
      active: boolean;
      worktreePath?: string;
    }>;
    tasks: { pending: number; assigned: number };
    controlPlane: {
      daemonAlive: boolean;
      projectServiceAlive: boolean;
    };
    flash: string | null;
    metadata: ReturnType<typeof loadMetadataState>["sessions"];
    updatedAt: string;
  } {
    const desktopState = this.desktopStateSnapshot ?? this.buildDesktopStateSnapshot();
    return {
      project: basename(process.cwd()),
      dashboardScreen: this.dashboardState.screen,
      sessions: [
        ...desktopState.sessions.map((session) => ({
          id: session.id,
          kind: "agent" as const,
          tool: session.command,
          label: session.label,
          tmuxWindowId: session.tmuxWindowId,
          tmuxWindowIndex: session.tmuxWindowIndex,
          windowName: session.command,
          headline: session.headline,
          status: session.status,
          role: session.role,
          active: session.active,
          worktreePath: session.worktreePath,
          semantic: session.semantic,
        })),
        ...desktopState.services.map((service) => ({
          id: service.id,
          kind: "service" as const,
          tool: service.command,
          label: service.label,
          tmuxWindowId: service.tmuxWindowId,
          tmuxWindowIndex: service.tmuxWindowIndex,
          windowName: service.command,
          headline: service.previewLine,
          status: service.status,
          active: service.active,
          worktreePath: service.worktreePath,
        })),
      ],
      tasks: this.taskDispatcher?.getTaskCounts() ?? { pending: 0, assigned: 0 },
      controlPlane: {
        daemonAlive: Boolean(loadDaemonInfo()),
        projectServiceAlive: true,
      },
      flash: this.footerFlash,
      metadata: loadMetadataState().sessions,
      updatedAt: new Date().toISOString(),
    };
  }

  private buildDesktopState(): {
    sessions: DashboardSession[];
    services: DashboardService[];
    statusline: ReturnType<Multiplexer["buildStatuslineSnapshot"]>;
    worktrees: Array<{ name: string; path: string; branch: string; isBare: boolean }>;
    mainCheckoutInfo: { name: string; branch: string };
    mainCheckoutPath?: string;
  } {
    if (!this.desktopStateSnapshot) {
      this.refreshDesktopStateSnapshot();
    }
    const desktopState = this.desktopStateSnapshot ?? this.buildDesktopStateSnapshot();
    return {
      sessions: desktopState.sessions,
      services: desktopState.services,
      statusline: this.buildStatuslineSnapshot(),
      worktrees: desktopState.worktrees,
      mainCheckoutInfo: desktopState.mainCheckoutInfo,
      mainCheckoutPath: desktopState.mainCheckoutPath,
    };
  }

  private reapplyDashboardPendingActions(): void {
    this.dashboardSessionsCache = this.dashboardPendingActions.applyToSessions(
      this.dashboardSessionsCache.map(
        ({ pendingAction: _pendingAction, optimistic: _optimistic, ...session }) => session,
      ),
    );
    this.dashboardServicesCache = this.dashboardPendingActions.applyToServices(
      this.dashboardServicesCache.map(
        ({ pendingAction: _pendingAction, optimistic: _optimistic, ...service }) => service,
      ),
    );
  }

  private listDesktopWorktrees(): Array<{ name: string; path: string; branch: string; isBare: boolean }> {
    return listAllWorktrees().filter((wt) => !wt.isBare);
  }

  async removeDesktopWorktree(path: string): Promise<{ path: string }> {
    this.syncSessionsFromState();

    const mainRepo = findMainRepo();
    if (path === mainRepo) {
      throw new Error("Cannot remove the main checkout");
    }

    const matching = this.listDesktopWorktrees().find((worktree) => worktree.path === path);
    if (!matching) {
      throw new Error(`Worktree "${path}" not found`);
    }

    const attachedSession = this.getDashboardSessions().find((session) => session.worktreePath === path);
    if (attachedSession) {
      throw new Error(
        `Cannot remove "${matching.name}" while agent "${attachedSession.label || attachedSession.id}" is attached`,
      );
    }
    const attachedService = this.getDashboardServices().find((service) => service.worktreePath === path);
    if (attachedService) {
      throw new Error(
        `Cannot remove "${matching.name}" while service "${attachedService.label || attachedService.id}" is attached`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      let child;
      try {
        child = spawn("git", ["worktree", "remove", path, "--force"], {
          cwd: mainRepo,
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = stderr
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
        reject(new Error(detail || `git worktree remove exited with code ${code ?? 1}`));
      });
    });

    return { path };
  }

  private listGraveyardEntries(): SessionState[] {
    try {
      const content = readFileSync(getGraveyardPath(), "utf-8");
      return JSON.parse(content) as SessionState[];
    } catch {
      return [];
    }
  }

  async resurrectGraveyardSession(sessionId: string): Promise<{ sessionId: string; status: "offline" }> {
    this.loadOfflineSessions();
    const graveyardEntries = this.listGraveyardEntries();
    const entry = graveyardEntries.find((candidate) => candidate.id === sessionId);
    if (!entry) {
      throw new Error(`Graveyard session "${sessionId}" not found`);
    }

    const nextGraveyard = graveyardEntries.filter((candidate) => candidate.id !== sessionId);
    writeFileSync(getGraveyardPath(), JSON.stringify(nextGraveyard, null, 2) + "\n");

    this.offlineSessions.push(entry);
    const statePath = getStatePath();
    try {
      let state: SavedState = { savedAt: new Date().toISOString(), cwd: process.cwd(), sessions: [] };
      if (existsSync(statePath)) {
        state = JSON.parse(readFileSync(statePath, "utf-8")) as SavedState;
      }
      state.sessions.push(entry);
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    } catch {}

    debug(`resurrected ${entry.id} from graveyard`, "session");
    return { sessionId, status: "offline" };
  }

  /** Remove sessions file on exit */
  private removeSessionsFile(): void {
    try {
      unlinkSync(`${getLocalAimuxDir()}/sessions.json`);
    } catch {}
  }

  private stripAnsi(text: string): string {
    return stripAnsi(text);
  }

  private centerInWidth(text: string, width: number): string {
    const pad = Math.max(0, Math.floor((width - this.stripAnsi(text).length) / 2));
    return " ".repeat(pad) + text;
  }

  private renderCurrentDashboardView(): void {
    if (this.isDashboardScreen("activity")) {
      this.renderActivityDashboard();
      return;
    }
    if (this.isDashboardScreen("workflow")) {
      this.renderWorkflow();
      return;
    }
    if (this.isDashboardScreen("threads")) {
      this.renderThreads();
      return;
    }
    if (this.isDashboardScreen("plans")) {
      this.renderPlans();
      return;
    }
    if (this.isDashboardScreen("help")) {
      this.renderHelp();
      return;
    }
    if (this.isDashboardScreen("graveyard")) {
      this.renderGraveyard();
      return;
    }
    this.renderDashboard();
    this.renderActiveDashboardOverlay();
  }

  /** Track previous statuses for notification on transition */
  private prevStatuses = new Map<string, string>();
  /** Flash message shown temporarily in footer, cleared after a few renders */
  private get dashboardBusyState(): DashboardBusyState | null {
    return this.dashboardFeedback.busyState;
  }

  private set dashboardBusyState(value: DashboardBusyState | null) {
    this.dashboardFeedback.busyState = value;
  }

  private get dashboardErrorState(): DashboardErrorState | null {
    return this.dashboardFeedback.errorState;
  }

  private set dashboardErrorState(value: DashboardErrorState | null) {
    this.dashboardFeedback.errorState = value;
  }

  private get footerFlash(): string | null {
    return this.dashboardFeedback.flash;
  }

  private set footerFlash(value: string | null) {
    this.dashboardFeedback.flash = value;
  }

  private get footerFlashTicks(): number {
    return this.dashboardFeedback.flashTicks;
  }

  private set footerFlashTicks(value: number) {
    this.dashboardFeedback.flashTicks = value;
  }

  private startStatusRefresh(): void {
    if (this.statusInterval) return;
    this.statusInterval = setInterval(() => {
      let dashboardNeedsRender = false;
      if (this.mode === "project-service") {
        this.taskDispatcher?.tick(this.sessions.map((s) => s.id));
        this.orchestrationDispatcher?.tick(this.sessions.map((s) => s.id));
        this.writeStatuslineFile();
      }

      const events = this.taskDispatcher?.drainEvents() ?? [];
      for (const ev of events) {
        if (ev.type === "assigned") {
          this.footerFlash = `⧫ Task assigned → ${ev.sessionId}`;
        } else if (ev.type === "completed") {
          this.footerFlash = `✓ Task done by ${ev.sessionId}`;
        } else if (ev.type === "failed") {
          this.footerFlash = `✗ Task failed: ${ev.sessionId}`;
        } else if (ev.type === "review_created") {
          this.footerFlash = `⧫ Review created: ${ev.description}`;
        } else if (ev.type === "review_approved") {
          this.footerFlash = `✓ Review approved: ${ev.description}`;
        } else if (ev.type === "changes_requested") {
          this.footerFlash = `↻ Changes requested: ${ev.description}`;
        }
        this.footerFlashTicks = 3;
        dashboardNeedsRender = true;
      }

      const orchestrationEvents = this.orchestrationDispatcher?.drainEvents() ?? [];
      for (const event of orchestrationEvents) {
        if (event.type === "message_delivered") {
          this.footerFlash = `✉ Message delivered → ${event.sessionId}`;
          this.footerFlashTicks = 3;
          dashboardNeedsRender = true;
        }
      }

      if (this.dashboardFeedback.tickFlashVisibilityChanged()) {
        dashboardNeedsRender = true;
      }

      for (const session of this.sessions) {
        const prev = this.prevStatuses.get(session.id);
        const curr = session.status;
        if (prev && prev !== curr && curr === "idle" && prev === "running") {
          this.publishAlert({
            kind: "needs_input",
            sessionId: session.id,
            title: `${session.id} needs input`,
            message: "Agent is waiting for input.",
            dedupeKey: `idle-needs-input:${session.id}`,
            cooldownMs: 15_000,
          });
        }
        this.prevStatuses.set(session.id, curr);
      }

      if (this.mode === "dashboard") {
        const now = Date.now();
        if (now >= this.dashboardNextBackgroundRefreshAt) {
          this.dashboardNextBackgroundRefreshAt = now + 5000;
          void this.refreshDashboardModelFromService().then((refreshed) => {
            if (refreshed || dashboardNeedsRender) {
              this.renderCurrentDashboardView();
            }
          });
        } else if (dashboardNeedsRender) {
          this.renderCurrentDashboardView();
        }
      }
    }, 1000);
  }

  private stopStatusRefresh(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
  }

  /** Load offline sessions from state.json, excluding any that are owned by live instances */
  private syncSessionsFromState(state = Multiplexer.loadState()): void {
    this.restoreTmuxSessionsFromState(state);
    this.loadOfflineSessions(state);
    this.loadOfflineServices(state);
    this.invalidateDesktopStateSnapshot();
  }

  private loadOfflineSessions(state = Multiplexer.loadState()): boolean {
    if (!state || state.sessions.length === 0) {
      const changed = this.offlineSessions.length > 0;
      this.offlineSessions = [];
      return changed;
    }

    // Get all session IDs owned by live instances (including ourselves)
    const ownedIds = new Set<string>();
    for (const s of this.sessions) ownedIds.add(s.id);
    for (const inst of this.getRemoteInstancesSafe()) {
      for (const rs of inst.sessions) ownedIds.add(rs.id);
    }

    // Also exclude by backendSessionId to catch resumed sessions with new IDs
    const ownedBackendIds = new Set(
      this.sessions.map((session) => session.backendSessionId).filter((value): value is string => Boolean(value)),
    );

    const nextOfflineSessions = state.sessions.filter((s) => {
      if (ownedIds.has(s.id)) return false;
      if (s.backendSessionId && ownedBackendIds.has(s.backendSessionId)) return false;
      if (s.worktreePath && !existsSync(s.worktreePath)) return false;
      return true;
    });
    const previousKey = this.offlineSessions
      .map((session) => `${session.id}:${session.label ?? ""}:${session.worktreePath ?? ""}`)
      .join("|");
    const nextKey = nextOfflineSessions
      .map((session) => `${session.id}:${session.label ?? ""}:${session.worktreePath ?? ""}`)
      .join("|");
    this.offlineSessions = nextOfflineSessions;

    if (this.offlineSessions.length > 0) {
      debug(`loaded ${this.offlineSessions.length} offline session(s) from state.json`, "session");
    }
    return previousKey !== nextKey;
  }

  private loadOfflineServices(state = Multiplexer.loadState()): boolean {
    const savedServices = state?.services ?? [];
    if (savedServices.length === 0) {
      const changed = this.offlineServices.length > 0;
      this.offlineServices = [];
      return changed;
    }

    const liveServiceIds = new Set(
      this.tmuxRuntimeManager
        .listProjectManagedWindows(process.cwd())
        .filter(({ target, metadata }) => !isDashboardWindowName(target.windowName) && metadata.kind === "service")
        .map(({ metadata }) => metadata.sessionId),
    );

    const nextOfflineServices = savedServices.filter((service) => {
      if (liveServiceIds.has(service.id)) return false;
      if (service.worktreePath && !existsSync(service.worktreePath)) return false;
      return true;
    });
    const previousKey = this.offlineServices
      .map(
        (service) =>
          `${service.id}:${service.label ?? ""}:${service.worktreePath ?? ""}:${service.launchCommandLine ?? ""}`,
      )
      .join("|");
    const nextKey = nextOfflineServices
      .map(
        (service) =>
          `${service.id}:${service.label ?? ""}:${service.worktreePath ?? ""}:${service.launchCommandLine ?? ""}`,
      )
      .join("|");
    this.offlineServices = nextOfflineServices;
    return previousKey !== nextKey;
  }

  private buildLiveServiceStates(): ServiceState[] {
    const seen = new Set<string>();
    const liveServices: ServiceState[] = [];
    for (const { metadata } of this.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
      if (metadata.kind !== "service") continue;
      if (seen.has(metadata.sessionId)) continue;
      seen.add(metadata.sessionId);
      const launchCommandLine =
        metadata.command === "shell" ? "" : metadata.args?.[0] === "-lc" ? (metadata.args[1] ?? "") : "";
      liveServices.push({
        id: metadata.sessionId,
        worktreePath: metadata.worktreePath,
        label: metadata.label,
        launchCommandLine,
      });
    }
    return liveServices;
  }

  private restoreTmuxSessionsFromState(state = Multiplexer.loadState()): void {
    const savedById = new Map((state?.sessions ?? []).map((session) => [session.id, session]));

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    for (const { target, metadata } of this.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
      if (isDashboardWindowName(target.windowName)) continue;
      if (metadata.kind === "service") continue;
      if (this.sessions.some((session) => session.id === metadata.sessionId)) continue;

      const transport = new TmuxSessionTransport(
        metadata.sessionId,
        metadata.command,
        target,
        this.tmuxRuntimeManager,
        cols,
        rows,
      );
      transport.backendSessionId = metadata.backendSessionId;
      this.sessionTmuxTargets.set(metadata.sessionId, target);
      this.registerManagedSession(transport, metadata.args, metadata.toolConfigKey, metadata.worktreePath, undefined);

      const saved = savedById.get(metadata.sessionId);
      const label = metadata.label ?? saved?.label;
      if (label) {
        this.sessionLabels.set(metadata.sessionId, label);
      }
      if (target.windowName !== metadata.command) {
        transport.renameWindow(metadata.command);
      }
      this.syncTmuxWindowMetadata(metadata.sessionId);
    }
  }

  /** Remove an offline session and move it to state-trash.json */
  /** Stop a running session and move it to offline (first [x]) */
  private stopSessionToOffline(session: ManagedSession): void {
    if (this.stoppingSessionIds.has(session.id)) return;
    // Save state before killing
    const offlineEntry: SessionState = {
      id: session.id,
      tool: session.command,
      toolConfigKey: this.sessionToolKeys.get(session.id) ?? session.command,
      command: session.command,
      args: this.sessionOriginalArgs.get(session.id) ?? [],
      backendSessionId: session.backendSessionId as string | undefined,
      worktreePath: this.sessionWorktreePaths.get(session.id),
      label: this.getSessionLabel(session.id),
      headline: this.deriveHeadline(session.id),
    };

    // Add to offline list so it appears immediately
    if (!this.offlineSessions.some((entry) => entry.id === session.id)) {
      this.offlineSessions.push(offlineEntry);
    }
    this.stoppingSessionIds.add(session.id);

    // Prevent the onExit handler from exiting aimux if this was the last session
    this.startedInDashboard = true;

    // Kill the PTY (onExit handler will remove from this.sessions)
    session.kill();

    debug(`stopped session ${session.id} → offline`, "session");
  }

  /** Move an offline session to the graveyard (second [x]) */
  /** After removing a session, adjust cursor to nearest sibling or step back to worktree level */
  private adjustAfterRemove(hasWorktrees: boolean): void {
    if (hasWorktrees && this.dashboardState.level === "sessions") {
      this.updateWorktreeSessions();
      if (this.dashboardState.worktreeEntries.length === 0) {
        // No more items in this worktree — step back to worktree level
        this.dashboardState.level = "worktrees";
      } else if (this.dashboardState.sessionIndex >= this.dashboardState.worktreeEntries.length) {
        this.dashboardState.sessionIndex = this.dashboardState.worktreeEntries.length - 1;
      }
    } else if (!hasWorktrees) {
      const total = this.getDashboardSessions().length;
      if (this.activeIndex >= total) {
        this.activeIndex = Math.max(0, total - 1);
      }
    }
  }

  private graveyardSession(sessionId: string): void {
    const session = this.offlineSessions.find((s) => s.id === sessionId);
    if (!session) return;

    // Remove from offline list
    this.offlineSessions = this.offlineSessions.filter((s) => s.id !== sessionId);

    // Append to graveyard file
    const graveyardPath = getGraveyardPath();
    let graveyard: SessionState[] = [];
    if (existsSync(graveyardPath)) {
      try {
        graveyard = JSON.parse(readFileSync(graveyardPath, "utf-8"));
      } catch {}
    }
    graveyard.push({ ...session, id: session.id });
    writeFileSync(graveyardPath, JSON.stringify(graveyard, null, 2) + "\n");

    // Also remove from state.json
    const statePath = getStatePath();
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8")) as SavedState;
        state.sessions = state.sessions.filter((s) => s.id !== sessionId);
        writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      } catch {}
    }

    debug(`graveyarded session ${sessionId}`, "session");
  }

  private isSessionRuntimeLive(runtime: ManagedSession): boolean {
    if (runtime.exited) return false;
    const mappedTarget = this.sessionTmuxTargets.get(runtime.id);
    const runtimeTarget = runtime.transport instanceof TmuxSessionTransport ? runtime.transport.tmuxTarget : undefined;
    const target = mappedTarget ?? runtimeTarget;
    if (!target) return false;
    try {
      return Boolean(this.tmuxRuntimeManager.getTargetByWindowId(target.sessionName, target.windowId));
    } catch {
      return false;
    }
  }

  private evictZombieSession(runtime: ManagedSession): void {
    const idx = this.sessions.indexOf(runtime);
    if (idx >= 0) {
      this.sessions.splice(idx, 1);
    }
    this.stoppingSessionIds.delete(runtime.id);
    this.sessionTmuxTargets.delete(runtime.id);
    this.writeSessionsFile();
    this.updateContextWatcherSessions();
    this.saveState();
  }

  /** Resume a specific offline session */
  private resumeOfflineSession(session: SessionState): void {
    const existing = this.sessions.find((runtime) => runtime.id === session.id);
    if (existing) {
      if (this.isSessionRuntimeLive(existing)) {
        this.offlineSessions = this.offlineSessions.filter((s) => s.id !== session.id);
        this.invalidateDesktopStateSnapshot();
        this.writeStatuslineFile();
        return;
      }
      this.evictZombieSession(existing);
    }

    const config = loadConfig();
    const toolCfg = config.tools[session.toolConfigKey];
    if (!toolCfg) return;

    const derived = loadMetadataState().sessions[session.id]?.derived;
    const relaunchFresh = derived?.activity === "error" || derived?.attention === "error";
    const useBackendResume =
      !relaunchFresh && this.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, session.backendSessionId);

    let actionArgs: string[];
    if (useBackendResume) {
      actionArgs = toolCfg.resumeArgs!.map((a: string) => a.replace("{sessionId}", session.backendSessionId!));
    } else if (relaunchFresh) {
      actionArgs = [];
    } else {
      actionArgs = [...(toolCfg.resumeFallback ?? [])];
    }
    const args = [...(toolCfg.args ?? []), ...actionArgs];

    if (relaunchFresh) {
      updateSessionMetadata(session.id, (current) => {
        const next = { ...current };
        delete next.derived;
        delete next.status;
        delete next.progress;
        return next;
      });
    }

    const preservedLabel = session.label ?? this.getSessionLabel(session.id);

    this.offlineSessions = this.offlineSessions.filter((s) => s.id !== session.id);
    this.invalidateDesktopStateSnapshot();
    this.saveState();
    this.writeStatuslineFile();

    if (preservedLabel) {
      this.sessionLabels.set(session.id, preservedLabel);
    }

    debug(
      `resuming offline session ${session.id} (${relaunchFresh ? "fresh" : useBackendResume ? `backend=${session.backendSessionId ?? "none"}` : "fallback"})`,
      "session",
    );
    this.createSession(
      session.command,
      args,
      toolCfg.preambleFlag,
      session.toolConfigKey,
      undefined,
      undefined, // don't pass sessionIdFlag — we're resuming with existing backend ID
      session.worktreePath,
      useBackendResume ? session.backendSessionId : undefined,
      session.id,
      true,
    );
  }

  private startHeartbeat(): void {
    this.runtimeSync.startHeartbeat();
  }

  /**
   * Handle a session that was claimed (taken over) by another aimux instance.
   * Kill the local tmux transport and refresh the dashboard.
   */
  private handleSessionClaimed(sessionId: string): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    debug(`session ${sessionId} was claimed by another instance, killing local PTY`, "instance");

    // Kill the local PTY without going through normal exit flow (no offline/state save)
    session.kill();

    // Remove from sessions array
    const idx = this.sessions.indexOf(session);
    if (idx >= 0) {
      this.sessions.splice(idx, 1);
      this.sessionToolKeys.delete(sessionId);
      this.sessionOriginalArgs.delete(sessionId);
      this.sessionWorktreePaths.delete(sessionId);
      this.sessionTmuxTargets.delete(sessionId);
    }

    // Adjust active index
    if (this.activeIndex >= this.sessions.length) {
      this.activeIndex = Math.max(0, this.sessions.length - 1);
    }

    this.renderDashboard();
  }

  private stopHeartbeat(): void {
    this.runtimeSync.stopHeartbeat();
  }

  private startProjectServiceRefresh(): void {
    this.runtimeSync.startProjectServiceRefresh();
  }

  private stopProjectServiceRefresh(): void {
    this.runtimeSync.stopProjectServiceRefresh();
  }

  private getRemoteInstancesSafe() {
    return this.instanceDirectory.getRemoteInstancesSafe(this.instanceId, process.cwd());
  }

  private getRemoteOwnedSessionKeys(): Set<string> {
    return this.instanceDirectory.getRemoteOwnedSessionKeys(this.instanceId, process.cwd());
  }

  /** Build InstanceSessionRef[] from current sessions for heartbeat/registry updates. */
  private getInstanceSessionRefs(): InstanceSessionRef[] {
    return this.sessions.map((s) => ({
      id: s.id,
      tool: s.command,
      backendSessionId: s.backendSessionId,
      worktreePath: this.sessionWorktreePaths.get(s.id),
    }));
  }

  /** Get the shared state.json path (in main repo for cross-worktree visibility). */
  private static getSharedStatePath(): string {
    return getStatePath();
  }

  /** Save session state to main repo's .aimux/state.json, merging with existing state. */
  private saveState(): void {
    const liveSessions = this.sessions.map((s) => ({
      id: s.id,
      tool: s.command,
      toolConfigKey: this.sessionToolKeys.get(s.id) ?? s.command,
      command: s.command,
      args: this.sessionOriginalArgs.get(s.id) ?? [],
      backendSessionId: s.backendSessionId,
      worktreePath: this.sessionWorktreePaths.get(s.id),
      label: this.getSessionLabel(s.id),
      headline: this.deriveHeadline(s.id),
      tmuxTarget: this.sessionTmuxTargets.get(s.id),
    }));
    const mySessions = [...this.offlineSessions, ...liveSessions];
    const liveServices = this.buildLiveServiceStates();
    const myServices = [...this.offlineServices, ...liveServices].filter(
      (service, index, services) => services.findIndex((entry) => entry.id === service.id) === index,
    );
    if (mySessions.length === 0 && myServices.length === 0) return;

    // Merge with existing state (other instances may have written their sessions)
    const statePath = Multiplexer.getSharedStatePath();
    let mergedSessions: SessionState[] = mySessions;
    let mergedServices: ServiceState[] = myServices;

    if (existsSync(statePath)) {
      try {
        const existing = JSON.parse(readFileSync(statePath, "utf-8")) as SavedState;
        // Keep existing sessions that don't collide with ours (dedup by backendSessionId)
        const myBackendIds = new Set(mySessions.map((s) => s.backendSessionId).filter(Boolean));
        const myIds = new Set(mySessions.map((s) => s.id));
        const otherSessions = existing.sessions.filter((s) => {
          if (s.backendSessionId && myBackendIds.has(s.backendSessionId)) return false;
          if (myIds.has(s.id)) return false;
          return true;
        });
        mergedSessions = [...otherSessions, ...mySessions];

        const myServiceIds = new Set(myServices.map((service) => service.id));
        const otherServices = (existing.services ?? []).filter((service) => !myServiceIds.has(service.id));
        mergedServices = [...otherServices, ...myServices];
      } catch {
        // Corrupt file — just overwrite with ours
      }
    }

    const state: SavedState = {
      savedAt: new Date().toISOString(),
      cwd: process.cwd(),
      sessions: mergedSessions,
      services: mergedServices,
    };

    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    this.invalidateDesktopStateSnapshot();
  }

  /** Load saved state from global project state dir */
  static loadState(): SavedState | null {
    const statePath = getStatePath();
    if (!existsSync(statePath)) return null;

    try {
      const raw = readFileSync(statePath, "utf-8");
      const state = JSON.parse(raw) as SavedState;

      return state;
    } catch {
      return null;
    }
  }

  private teardown(): void {
    debug("teardown started", "session");
    this.clearDashboardBusy();
    this.stopHeartbeat();
    this.stopProjectServiceRefresh();
    this.taskDispatcher = null;
    this.orchestrationDispatcher = null;
    this.instanceDirectory.unregisterInstance(this.instanceId, process.cwd()).catch(() => {});
    this.saveState();
    this.stopStatusRefresh();
    this.contextWatcher.stop();
    this.removeSessionsFile();
    this.removeInstructionFiles();
    closeDebug();
    if (this.onStdinData) {
      process.stdin.removeListener("data", this.onStdinData);
    }
    if (this.onResize) {
      process.stdout.removeListener("resize", this.onResize);
    }
    this.hotkeys.destroy();
    this.terminalHost.restoreTerminalState();
  }

  cleanup(): void {
    for (const session of this.sessions) {
      session.destroy();
    }
    void this.stopProjectServices().catch(() => {});
    this.teardown();
  }

  cleanupTerminalOnly(): void {
    this.terminalHost.restoreTerminalState();
  }

  private exitDashboardClientOrProcess(): void {
    const insideTmux = this.tmuxRuntimeManager.isInsideTmux();
    const currentSession = insideTmux ? this.tmuxRuntimeManager.currentClientSession() : null;
    if (insideTmux && currentSession && this.tmuxRuntimeManager.isManagedSessionName(currentSession)) {
      this.tmuxRuntimeManager.leaveManagedSession({
        insideTmux: true,
        sessionName: this.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
      });
      return;
    }
    this.cleanup();
    process.exit(0);
  }
}
