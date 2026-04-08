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
import { dashboardInteractionMethods, type DashboardInteractionMethods } from "./multiplexer-dashboard-interaction.js";
import { dashboardViewMethods, type DashboardViewMethods } from "./multiplexer-dashboard-view-methods.js";
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
  adjustAfterRemove as adjustAfterRemoveImpl,
  buildLiveServiceStates as buildLiveServiceStatesImpl,
  evictZombieSession as evictZombieSessionImpl,
  getInstanceSessionRefs as getInstanceSessionRefsImpl,
  getRemoteInstancesSafe as getRemoteInstancesSafeImpl,
  getRemoteOwnedSessionKeys as getRemoteOwnedSessionKeysImpl,
  graveyardSession as graveyardSessionImpl,
  handleSessionClaimed as handleSessionClaimedImpl,
  isSessionRuntimeLive as isSessionRuntimeLiveImpl,
  listDesktopWorktrees as listDesktopWorktreesImpl,
  loadOfflineServices as loadOfflineServicesImpl,
  loadOfflineSessions as loadOfflineSessionsImpl,
  removeDesktopWorktree as removeDesktopWorktreeImpl,
  removeSessionsFile as removeSessionsFileImpl,
  renderCurrentDashboardView as renderCurrentDashboardViewImpl,
  restoreTmuxSessionsFromState as restoreTmuxSessionsFromStateImpl,
  resumeOfflineSession as resumeOfflineSessionImpl,
  startHeartbeat as startHeartbeatImpl,
  startProjectServiceRefresh as startProjectServiceRefreshImpl,
  startStatusRefresh as startStatusRefreshImpl,
  stopHeartbeat as stopHeartbeatImpl,
  stopProjectServiceRefresh as stopProjectServiceRefreshImpl,
  stopSessionToOffline as stopSessionToOfflineImpl,
  stopStatusRefresh as stopStatusRefreshImpl,
  syncSessionsFromState as syncSessionsFromStateImpl,
  writeSessionsFile as writeSessionsFileImpl,
} from "./multiplexer-runtime-state.js";
import {
  applyDashboardSessionLabel as applyDashboardSessionLabelImpl,
  applySessionLabel as applySessionLabelImpl,
  buildTmuxWindowMetadata as buildTmuxWindowMetadataImpl,
  deriveHeadline as deriveHeadlineImpl,
  getSessionLabel as getSessionLabelImpl,
  handleSessionRuntimeEvent as handleSessionRuntimeEventImpl,
  interruptAgent as interruptAgentImpl,
  normalizeAgentInput as normalizeAgentInputImpl,
  paneStillContainsAgentDraft as paneStillContainsAgentDraftImpl,
  readAgentHistory as readAgentHistoryImpl,
  readAgentOutput as readAgentOutputImpl,
  readStatusHeadline as readStatusHeadlineImpl,
  registerManagedSession as registerManagedSessionImpl,
  resolveRunningSession as resolveRunningSessionImpl,
  scheduleTmuxAgentSubmit as scheduleTmuxAgentSubmitImpl,
  syncTmuxWindowMetadata as syncTmuxWindowMetadataImpl,
  updateContextWatcherSessions as updateContextWatcherSessionsImpl,
  updateSessionLabel as updateSessionLabelImpl,
  writeAgentInput as writeAgentInputImpl,
  writeTmuxAgentInput as writeTmuxAgentInputImpl,
} from "./multiplexer-session-runtime-core.js";
import {
  createSession as createSessionImpl,
  focusSession as focusSessionImpl,
  getScopedSessionEntries as getScopedSessionEntriesImpl,
  getSessionWorktreePath as getSessionWorktreePathImpl,
  getSessionsByWorktree as getSessionsByWorktreeImpl,
  handleAction as handleActionImpl,
  migrateAgent as migrateAgentImpl,
  restoreSessions as restoreSessionsImpl,
  resumeSessions as resumeSessionsImpl,
  run as runImpl,
  runDashboard as runDashboardImpl,
  runProjectService as runProjectServiceImpl,
} from "./multiplexer-session-launch.js";
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

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
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
    return getSessionLabelImpl(this, sessionId);
  }

  private applySessionLabel(sessionId: string, label?: string): void {
    applySessionLabelImpl(this, sessionId, label);
  }

  private applyDashboardSessionLabel(sessionId: string, label?: string): void {
    applyDashboardSessionLabelImpl(this, sessionId, label);
  }

  private async updateSessionLabel(sessionId: string, label?: string): Promise<void> {
    await updateSessionLabelImpl(this, sessionId, label);
  }

  private readStatusHeadline(sessionId: string): string | undefined {
    return readStatusHeadlineImpl(this, sessionId);
  }

  private deriveHeadline(sessionId: string): string | undefined {
    return deriveHeadlineImpl(this, sessionId);
  }

  private resolveRunningSession(sessionId: string): ManagedSession {
    return resolveRunningSessionImpl(this, sessionId);
  }

  private writeTmuxAgentInput(sessionId: string, transport: TmuxSessionTransport, data: string): void {
    writeTmuxAgentInputImpl(this, sessionId, transport, data);
  }

  private normalizeAgentInput(data: string, submit: boolean): string {
    return normalizeAgentInputImpl(this, data, submit);
  }

  private paneStillContainsAgentDraft(target: TmuxTarget, draft: string): boolean {
    return paneStillContainsAgentDraftImpl(this, target, draft);
  }

  private scheduleTmuxAgentSubmit(sessionId: string, target: TmuxTarget, draft: string): void {
    scheduleTmuxAgentSubmitImpl(this, sessionId, target, draft);
  }

  async writeAgentInput(
    sessionId: string,
    data = "",
    parts?: AgentInputPart[],
    clientMessageId?: string,
    submit = false,
  ): Promise<{ sessionId: string }> {
    return writeAgentInputImpl(this, sessionId, data, parts, clientMessageId, submit);
  }

  async readAgentHistory(
    sessionId: string,
    lastN?: number,
  ): Promise<{ sessionId: string; messages: ReturnType<typeof readSessionMessages>; lastN?: number }> {
    return readAgentHistoryImpl(this, sessionId, lastN);
  }

  async interruptAgent(sessionId: string): Promise<{ sessionId: string }> {
    return interruptAgentImpl(this, sessionId);
  }

  async readAgentOutput(
    sessionId: string,
    startLine?: number,
  ): Promise<{ sessionId: string; output: string; startLine?: number; parsed: ParsedAgentOutput }> {
    return readAgentOutputImpl(this, sessionId, startLine);
  }

  private registerManagedSession(
    session: SessionTransport,
    args: string[],
    toolConfigKey?: string,
    worktreePath?: string,
    role?: string,
    startTime?: number,
  ): ManagedSession {
    return registerManagedSessionImpl(this, session, args, toolConfigKey, worktreePath, role, startTime);
  }

  private handleSessionRuntimeEvent(runtime: ManagedSession, event: SessionRuntimeEvent): void {
    handleSessionRuntimeEventImpl(this, runtime, event);
  }

  private buildTmuxWindowMetadata(sessionId: string, command: string): TmuxWindowMetadata {
    return buildTmuxWindowMetadataImpl(this, sessionId, command);
  }

  private syncTmuxWindowMetadata(sessionId: string): void {
    syncTmuxWindowMetadataImpl(this, sessionId);
  }

  private updateContextWatcherSessions(): void {
    updateContextWatcherSessionsImpl(this);
  }

  private createTaskDispatcher(): TaskDispatcher {
    return new TaskDispatcher(
      (id) => this.sessions.find((s) => s.id === id),
      (id) => this.sessionToolKeys.get(id),
      (id) => this.sessionRoles.get(id),
      (id) => this.deriveSessionSemanticState(id).availability,
    );
  }

  private createOrchestrationDispatcher(): OrchestrationDispatcher {
    return new OrchestrationDispatcher((id) => this.sessions.find((s) => s.id === id));
  }

  private selectLinkedOrOpenTarget(target: TmuxTarget): void {
    selectLinkedOrOpenTarget(this.tmuxRuntimeManager, target);
  }

  async run(opts: { command: string; args: string[] }): Promise<number> {
    return runImpl(this, opts);
  }

  async runDashboard(): Promise<number> {
    return runDashboardImpl(this);
  }

  async runProjectService(): Promise<number> {
    return runProjectServiceImpl(this);
  }

  /**
   * Resume previous sessions using each tool's native resume mechanism.
   * Reads state.json and spawns sessions with resumeArgs instead of normal args.
   */
  async resumeSessions(toolFilter?: string): Promise<number> {
    return resumeSessionsImpl(this, toolFilter);
  }

  /**
   * Restore previous sessions by injecting prior history into the preamble.
   * Starts fresh sessions but with context from the previous conversation.
   */
  async restoreSessions(toolFilter?: string): Promise<number> {
    return restoreSessionsImpl(this, toolFilter);
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
    return createSessionImpl(
      this,
      command,
      args,
      preambleFlag,
      toolConfigKey,
      extraPreamble,
      sessionIdFlag,
      worktreePath,
      backendSessionIdOverride,
      sessionIdOverride,
      detachedInTmux,
    );
  }

  /**
   * Migrate an agent from its current worktree to a target worktree.
   * Copies history and context, kills the old session, starts a new one
   * with injected prior history.
   */
  async migrateAgent(sessionId: string, targetWorktreePath: string): Promise<void> {
    await migrateAgentImpl(this, sessionId, targetWorktreePath);
  }

  /** Get worktree path for a session */
  getSessionWorktreePath(sessionId: string): string | undefined {
    return getSessionWorktreePathImpl(this, sessionId);
  }

  /** Get all sessions grouped by worktree path */
  getSessionsByWorktree(): Map<string | undefined, ManagedSession[]> {
    return getSessionsByWorktreeImpl(this);
  }

  private getScopedSessionEntries(): Array<{ session: ManagedSession; index: number }> {
    return getScopedSessionEntriesImpl(this);
  }

  private focusSession(index: number): void {
    focusSessionImpl(this, index);
  }

  private handleAction(action: HotkeyAction): void {
    handleActionImpl(this, action);
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
    renderCurrentDashboardViewImpl(this);
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
    startStatusRefreshImpl(this);
  }

  private stopStatusRefresh(): void {
    stopStatusRefreshImpl(this);
  }

  /** Load offline sessions from state.json, excluding any that are owned by live instances */
  private syncSessionsFromState(state = Multiplexer.loadState()): void {
    syncSessionsFromStateImpl(this, state);
  }

  private loadOfflineSessions(state = Multiplexer.loadState()): boolean {
    return loadOfflineSessionsImpl(this, state);
  }

  private loadOfflineServices(state = Multiplexer.loadState()): boolean {
    return loadOfflineServicesImpl(this, state);
  }

  private buildLiveServiceStates(): ServiceState[] {
    return buildLiveServiceStatesImpl(this);
  }

  private restoreTmuxSessionsFromState(state = Multiplexer.loadState()): void {
    restoreTmuxSessionsFromStateImpl(this, state);
  }

  /** Remove an offline session and move it to state-trash.json */
  /** Stop a running session and move it to offline (first [x]) */
  private stopSessionToOffline(session: ManagedSession): void {
    stopSessionToOfflineImpl(this, session);
  }

  /** Move an offline session to the graveyard (second [x]) */
  /** After removing a session, adjust cursor to nearest sibling or step back to worktree level */
  private adjustAfterRemove(hasWorktrees: boolean): void {
    adjustAfterRemoveImpl(this, hasWorktrees);
  }

  private graveyardSession(sessionId: string): void {
    graveyardSessionImpl(this, sessionId);
  }

  private isSessionRuntimeLive(runtime: ManagedSession): boolean {
    return isSessionRuntimeLiveImpl(this, runtime);
  }

  private evictZombieSession(runtime: ManagedSession): void {
    evictZombieSessionImpl(this, runtime);
  }

  /** Resume a specific offline session */
  private resumeOfflineSession(session: SessionState): void {
    resumeOfflineSessionImpl(this, session);
  }

  private startHeartbeat(): void {
    startHeartbeatImpl(this);
  }

  /**
   * Handle a session that was claimed (taken over) by another aimux instance.
   * Kill the local tmux transport and refresh the dashboard.
   */
  private handleSessionClaimed(sessionId: string): void {
    handleSessionClaimedImpl(this, sessionId);
  }

  private stopHeartbeat(): void {
    stopHeartbeatImpl(this);
  }

  private startProjectServiceRefresh(): void {
    startProjectServiceRefreshImpl(this);
  }

  private stopProjectServiceRefresh(): void {
    stopProjectServiceRefreshImpl(this);
  }

  private getRemoteInstancesSafe() {
    return getRemoteInstancesSafeImpl(this);
  }

  private getRemoteOwnedSessionKeys(): Set<string> {
    return getRemoteOwnedSessionKeysImpl(this);
  }

  /** Build InstanceSessionRef[] from current sessions for heartbeat/registry updates. */
  private getInstanceSessionRefs(): InstanceSessionRef[] {
    return getInstanceSessionRefsImpl(this);
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

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Multiplexer extends DashboardInteractionMethods, DashboardViewMethods {}

Object.assign(Multiplexer.prototype, dashboardInteractionMethods, dashboardViewMethods);
