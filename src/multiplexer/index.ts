import { randomUUID } from "node:crypto";
import { HotkeyHandler, type HotkeyAction } from "../hotkeys.js";
import { Dashboard, type DashboardService, type DashboardSession, type WorktreeGroup } from "../dashboard/index.js";
import { DashboardState } from "../dashboard/state.js";
import { ContextWatcher } from "../context/context-bridge.js";
import { loadConfig } from "../config.js";
import { findMainRepo } from "../worktree.js";
import { TaskDispatcher } from "../task-dispatcher.js";
import { TerminalHost } from "../terminal-host.js";
import { SessionRuntime, type SessionRuntimeEvent, type SessionTransport } from "../session-runtime.js";
import { AgentTracker } from "../agent-tracker.js";
import { InstanceDirectory } from "../instance-directory.js";
import { TmuxRuntimeManager, type TmuxTarget, type TmuxWindowMetadata } from "../tmux/runtime-manager.js";
import { MetadataServer } from "../metadata-server.js";
import { loadMetadataState } from "../metadata-store.js";
import { PluginRuntime } from "../plugin-runtime.js";
import { SessionBootstrapService } from "../session-bootstrap.js";
import { createThread, appendMessage, updateThread } from "../threads.js";
import { OrchestrationDispatcher } from "../orchestration-dispatcher.js";
import { ProjectEventBus, type AlertKind } from "../project-events.js";
import { deriveSessionSemantics } from "../session-semantics.js";
import { type NotificationRecord } from "../notifications.js";
import { type ThreadEntry, type WorkflowEntry, type WorkflowFilter } from "../workflow.js";
import { DashboardUiStateStore } from "../dashboard/ui-state-store.js";
import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import {
  DashboardFeedbackController,
  type DashboardBusyState,
  type DashboardErrorState,
} from "../dashboard/feedback.js";
import { MultiplexerRuntimeSync } from "./runtime-sync.js";
import { selectLinkedOrOpenTarget } from "../tmux/window-open.js";
import { dashboardActionMethods, type DashboardActionMethods } from "./dashboard-actions-methods.js";
import { agentIoMethods, type AgentIoMethods } from "./agent-io-methods.js";
import { dashboardInteractionMethods, type DashboardInteractionMethods } from "./dashboard-interaction.js";
import { dashboardStateMethods, type DashboardStateMethods } from "./dashboard-state-methods.js";
import { persistenceMethods, type PersistenceMethods } from "./persistence-methods.js";
import { dashboardTailMethods, type DashboardTailMethods } from "./dashboard-tail-methods.js";
import { loadStateStatic, runtimeLifecycleMethods, type RuntimeLifecycleMethods } from "./runtime-lifecycle-methods.js";
import { dashboardViewMethods, type DashboardViewMethods } from "./dashboard-view-methods.js";
import {
  buildTmuxWindowMetadata as buildTmuxWindowMetadataImpl,
  handleSessionRuntimeEvent as handleSessionRuntimeEventImpl,
  registerManagedSession as registerManagedSessionImpl,
  syncTmuxWindowMetadata as syncTmuxWindowMetadataImpl,
  updateContextWatcherSessions as updateContextWatcherSessionsImpl,
} from "./session-runtime-core.js";
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
} from "./session-launch.js";

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

interface WorktreeCreateJob {
  path: string;
  name: string;
  startedAt: number;
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
  private worktreeCreateJob: WorktreeCreateJob | null = null;
  private pendingWorktreeRemovals = new Map<string, Promise<{ path: string; status: "removing" | "removed" }>>();
  private pendingWorktreeCreates = new Map<string, Promise<{ path: string; status: "creating" | "created" }>>();
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
  private dashboardQuickJumpTimeout: ReturnType<typeof setTimeout> | null = null;
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
  private dashboardViewportPollInterval: ReturnType<typeof setInterval> | null = null;
  private dashboardLastViewportKey: string | null = null;
  private dashboardLastViewportSize: { cols: number; rows: number } | null = null;
  private dashboardPendingExpandedViewportSize: { cols: number; rows: number } | null = null;
  private dashboardPendingExpandedViewportCount = 0;
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

  private async forkSessionFromSource(
    sourceSessionId: string,
    targetToolConfigKey: string,
    requestedTargetSessionId?: string,
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
    const targetSessionId = requestedTargetSessionId ?? `${toolCfg.command}-${Math.random().toString(36).slice(2, 8)}`;
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
      const kickoff = this.sessionBootstrap.buildCodexForkKickoffPrompt(
        sourceSessionId,
        targetSessionId,
        sourceSnapshot,
        instruction,
      );
      await this.sessionBootstrap.deliverDetachedCodexKickoffPrompt(targetSessionId, kickoff, 1800);
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

  /** Instruction files we've written (to clean up on exit) */
  private writtenInstructionFiles = new Set<string>();

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

  /** Load saved state from global project state dir */
  static loadState(): SavedState | null {
    return loadStateStatic();
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Multiplexer
  extends
    DashboardInteractionMethods,
    DashboardViewMethods,
    DashboardActionMethods,
    DashboardTailMethods,
    PersistenceMethods,
    DashboardStateMethods,
    AgentIoMethods,
    RuntimeLifecycleMethods {}

Object.assign(
  Multiplexer.prototype,
  dashboardInteractionMethods,
  dashboardViewMethods,
  dashboardActionMethods,
  dashboardTailMethods,
  persistenceMethods,
  dashboardStateMethods,
  agentIoMethods,
  runtimeLifecycleMethods,
);
