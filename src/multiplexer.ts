import {
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  cpSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync, spawn, spawnSync } from "node:child_process";
import { HotkeyHandler, type HotkeyAction } from "./hotkeys.js";
import { Dashboard, type DashboardSession, type WorktreeGroup } from "./dashboard.js";
import { DashboardState, type DashboardScreen } from "./dashboard-state.js";
import { captureGitContext, ContextWatcher, buildContextPreamble } from "./context/context-bridge.js";
import { readHistory } from "./context/history.js";
import { parseKeys } from "./key-parser.js";
import { loadConfig, initProject, type ToolConfig } from "./config.js";
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
import { notifyPrompt, notifyComplete } from "./notify.js";
import { type InstanceSessionRef } from "./instance-registry.js";
import { TaskDispatcher, requestReview } from "./task-dispatcher.js";
import { loadTeamConfig } from "./team.js";
import { TerminalHost } from "./terminal-host.js";
import { SessionRuntime, type SessionRuntimeEvent, type SessionTransport } from "./session-runtime.js";
import { buildDashboardSessions, orderDashboardSessionsByVisualWorktree } from "./dashboard-session-registry.js";
import { AgentTracker } from "./agent-tracker.js";
import { InstanceDirectory } from "./instance-directory.js";
import { TmuxRuntimeManager, type TmuxTarget, type TmuxWindowMetadata } from "./tmux-runtime-manager.js";
import { isDashboardWindowName } from "./tmux-runtime-manager.js";
import { TmuxSessionTransport } from "./tmux-session-transport.js";
import { MetadataServer } from "./metadata-server.js";
import { loadMetadataEndpoint, loadMetadataState, removeMetadataEndpoint } from "./metadata-store.js";
import { PluginRuntime } from "./plugin-runtime.js";
import { SessionBootstrapService } from "./session-bootstrap.js";
import { readTask, type Task } from "./tasks.js";
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
import {
  buildThreadEntries,
  buildWorkflowEntries,
  filterWorkflowEntries,
  type ThreadEntry,
  type WorkflowEntry,
  type WorkflowFilter,
} from "./workflow.js";

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

export interface SavedState {
  savedAt: string;
  cwd: string;
  sessions: SessionState[];
}

type ManagedSession = SessionRuntime;

interface WorktreeRemovalJob {
  path: string;
  name: string;
  startedAt: number;
  oldIdx: number;
  stderr: string;
}

interface DashboardBusyState {
  title: string;
  lines: string[];
  startedAt: number;
  spinnerFrame: number;
}

interface DashboardErrorState {
  title: string;
  lines: string[];
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

interface DashboardOrchestrationTarget {
  label: string;
  sessionId?: string;
  assignee?: string;
  tool?: string;
  worktreePath?: string;
  recipientIds?: string[];
}

export class Multiplexer {
  private sessions: ManagedSession[] = [];
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
  private dashboardBusyState: DashboardBusyState | null = null;
  private dashboardBusySpinner: ReturnType<typeof setInterval> | null = null;
  private dashboardErrorState: DashboardErrorState | null = null;
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
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
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
  private pluginRuntime: PluginRuntime | null = null;
  private projectServiceInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.terminalHost = new TerminalHost();
    this.hotkeys = new HotkeyHandler((action) => this.handleAction(action));
    this.dashboard = new Dashboard();
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  get activeSession(): ManagedSession | null {
    return this.sessions[this.activeIndex] ?? null;
  }

  private isTmuxBackend(): boolean {
    return true;
  }

  private openTmuxDashboardTarget(): void {
    const session = this.tmuxRuntimeManager.ensureProjectSession(process.cwd());
    const openSession = this.tmuxRuntimeManager.getOpenSessionName(session.sessionName);
    const target = this.tmuxRuntimeManager.ensureDashboardWindow(openSession, process.cwd());
    this.tmuxRuntimeManager.openTarget(target, { insideTmux: this.tmuxRuntimeManager.isInsideTmux() });
  }

  private async startProjectServices(): Promise<void> {
    if (this.metadataServer) return;
    this.metadataServer = new MetadataServer({
      desktop: {
        getState: () => this.buildDesktopState(),
        listWorktrees: () => this.listDesktopWorktrees(),
        createWorktree: ({ name }) => ({ path: createWorktree(name) }),
        removeWorktree: ({ path }) => this.removeDesktopWorktree(path),
        listGraveyard: () => this.listGraveyardEntries(),
        resurrectGraveyard: ({ sessionId }) => this.resurrectGraveyardSession(sessionId),
      },
      threads: {
        sendMessage: (input) => this.sendOrchestrationMessage(input),
      },
      actions: {
        sendHandoff: (input) => this.sendHandoffMessage(input),
      },
      lifecycle: {
        spawnAgent: (input) =>
          this.spawnAgent({
            toolConfigKey: input.tool,
            targetWorktreePath: input.worktreePath,
            open: input.open ?? false,
          }),
        forkAgent: (input) =>
          this.forkAgent({
            sourceSessionId: input.sourceSessionId,
            targetToolConfigKey: input.tool,
            instruction: input.instruction,
            targetWorktreePath: input.worktreePath,
            open: input.open ?? false,
          }),
        stopAgent: (input) => this.stopAgent(input.sessionId),
        renameAgent: (input) => this.renameAgent(input.sessionId, input.label),
        migrateAgent: (input) => this.migrateAgentSession(input.sessionId, input.worktreePath),
        killAgent: (input) => this.sendAgentToGraveyard(input.sessionId),
      },
      onChange: () => {
        this.writeStatuslineFile();
        if (this.mode === "dashboard") {
          this.renderCurrentDashboardView();
        }
      },
    });
    await this.metadataServer.start();
    const endpoint = this.metadataServer.getAddress();
    if (endpoint) {
      this.pluginRuntime = new PluginRuntime({
        host: endpoint.host,
        port: endpoint.port,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      });
      await this.pluginRuntime.start();
    }
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
      if (session.status !== "idle" && session.status !== "waiting") continue;
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
    this.metadataServer?.stop();
    this.metadataServer = null;
    removeMetadataEndpoint();
    await this.pluginRuntime?.stop?.();
    this.pluginRuntime = null;
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

  private async updateSessionLabel(sessionId: string, label?: string): Promise<void> {
    this.applySessionLabel(sessionId, label);

    const localSession = this.sessions.find((session) => session.id === sessionId)?.transport;
    if (localSession instanceof TmuxSessionTransport) {
      localSession.renameWindow(label?.trim() || localSession.command);
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
    if (_code !== 0 && uptime < 10_000) {
      let errorHint = "";
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

    notifyComplete(runtime.id);
    captureGitContext(runtime.id, runtime.command).catch(() => {});

    const idx = this.sessions.indexOf(runtime);
    if (idx === -1) return;

    this.sessions.splice(idx, 1);
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
    this.restoreTmuxSessionsFromState();
    this.taskDispatcher = new TaskDispatcher(
      (id) => this.sessions.find((s) => s.id === id),
      (id) => this.sessionToolKeys.get(id),
      (id) => this.sessionRoles.get(id),
    );
    this.orchestrationDispatcher = new OrchestrationDispatcher((id) => this.sessions.find((s) => s.id === id));
    this.loadOfflineSessions();
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
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();

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
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();
    this.taskDispatcher = new TaskDispatcher(
      (id) => this.sessions.find((s) => s.id === id),
      (id) => this.sessionToolKeys.get(id),
      (id) => this.sessionRoles.get(id),
    );
    this.orchestrationDispatcher = new OrchestrationDispatcher((id) => this.sessions.find((s) => s.id === id));
    this.writeInstructionFiles();
    await this.startProjectServices();
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

    // Inject backend session ID flag (e.g. --session-id <uuid>)
    if (sessionIdFlag && backendSessionId) {
      const expandedFlag = sessionIdFlag.map((a) => a.replace("{sessionId}", backendSessionId));
      finalArgs = [...finalArgs, ...expandedFlag];
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
      command,
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

    // Focus the new session
    this.activeIndex = this.sessions.length - 1;
    if (this.startedInDashboard && this.mode === "dashboard") {
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
    const target = this.sessionTmuxTargets.get(sid);
    if (target) {
      this.saveState();
      this.tmuxRuntimeManager.openTarget(target, { insideTmux: this.tmuxRuntimeManager.isInsideTmux() });
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
    const hasWorktrees = this.dashboardState.hasWorktrees();

    // Digits 1-9: always focus session directly (shortcut)
    if (key >= "1" && key <= "9") {
      const index = parseInt(key, 10) - 1;
      void this.activateDashboardEntryByNumber(index);
      return;
    }

    if (key === "tab") {
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
        this.tmuxRuntimeManager.leaveManagedSession({
          insideTmux: this.tmuxRuntimeManager.isInsideTmux(),
          sessionName: this.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
        });
        this.cleanup();
        process.exit(0);
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

        const allDs = this.getDashboardSessions();
        const selId =
          this.dashboardState.level === "sessions" && this.dashboardState.worktreeSessions.length > 0
            ? this.dashboardState.worktreeSessions[this.dashboardState.sessionIndex]?.id
            : undefined;
        const selEntry = selId
          ? allDs.find((d) => d.id === selId)
          : !hasWorktrees
            ? allDs[this.activeIndex]
            : undefined;
        if (!selEntry) return;

        if (selEntry.status === "offline") {
          // Second [x] on offline → move to graveyard
          void this.graveyardSessionWithFeedback(selEntry.id, hasWorktrees);
          return;
        }
        // First [x] on running → stop PTY, keep as offline for resume
        const pty = this.sessions.find((s) => s.id === selEntry.id);
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
          this.dashboardState.level === "sessions" && this.dashboardState.worktreeSessions.length > 0
            ? this.dashboardState.worktreeSessions[this.dashboardState.sessionIndex]?.id
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
          if (entry && this.openLiveTmuxWindowForEntry(entry)) {
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
        case "d":
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
          if (this.dashboardState.worktreeSessions.length > 0) {
            this.dashboardState.level = "sessions";
            this.dashboardState.sessionIndex = 0;
            this.renderDashboard();
          }
          break;
        case "escape":
        case "d":
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
          if (this.dashboardState.worktreeSessions.length > 1) {
            this.dashboardState.sessionIndex =
              (this.dashboardState.sessionIndex + 1) % this.dashboardState.worktreeSessions.length;
            this.renderDashboard();
          }
          break;
        case "up":
        case "k":
        case "p":
          if (this.dashboardState.worktreeSessions.length > 1) {
            this.dashboardState.sessionIndex =
              (this.dashboardState.sessionIndex - 1 + this.dashboardState.worktreeSessions.length) %
              this.dashboardState.worktreeSessions.length;
            this.renderDashboard();
          }
          break;
        case "enter": {
          const dashEntry = this.dashboardState.worktreeSessions[this.dashboardState.sessionIndex];
          if (!dashEntry) break;
          if (this.openLiveTmuxWindowForEntry(dashEntry)) {
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

    if (this.openLiveTmuxWindowForEntry(entry)) {
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
      this.focusSession(ptyIdx);
    }
  }

  private attentionScore(entry: DashboardSession): number {
    if (entry.attention === "error") return 5;
    if (entry.attention === "needs_input") return 4;
    if (entry.attention === "blocked") return 3;
    if ((entry.unseenCount ?? 0) > 0) return 2;
    if (entry.activity === "done") return 1;
    return 0;
  }

  private getActivityEntries(): DashboardSession[] {
    return this.getDashboardSessionsInVisualOrder()
      .filter(
        (entry) =>
          this.attentionScore(entry) > 0 ||
          !!entry.activity ||
          entry.status === "running" ||
          entry.status === "waiting" ||
          (entry.unseenCount ?? 0) > 0,
      )
      .sort((a, b) => {
        const scoreDiff = this.attentionScore(b) - this.attentionScore(a);
        if (scoreDiff !== 0) return scoreDiff;
        const activeDiff = Number(b.active) - Number(a.active);
        if (activeDiff !== 0) return activeDiff;
        const aName = a.label ?? a.command;
        const bName = b.label ?? b.command;
        return aName.localeCompare(bName);
      });
  }

  private showActivityDashboard(): void {
    this.clearDashboardSubscreens();
    this.activityEntries = this.getActivityEntries();
    if (this.activityIndex >= this.activityEntries.length) {
      this.activityIndex = Math.max(0, this.activityEntries.length - 1);
    }
    this.setDashboardScreen("activity");
    this.writeStatuslineFile();
    this.renderActivityDashboard();
  }

  private buildWorkflowEntries(): WorkflowEntry[] {
    return filterWorkflowEntries(buildWorkflowEntries("user"), this.workflowFilter, "user");
  }

  private showWorkflow(): void {
    this.clearDashboardSubscreens();
    this.workflowEntries = this.buildWorkflowEntries();
    if (this.workflowIndex >= this.workflowEntries.length) {
      this.workflowIndex = Math.max(0, this.workflowEntries.length - 1);
    }
    this.setDashboardScreen("workflow");
    this.writeStatuslineFile();
    this.renderWorkflow();
  }

  private renderWorkflow(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const header: string[] = [];
    header.push("");
    header.push(
      this.centerInWidth(`\x1b[1maimux\x1b[0m — workflow \x1b[2m[${this.describeWorkflowFilter()}]\x1b[0m`, cols),
    );
    header.push(this.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
    header.push("");
    const footer = this.centerInWidth(
      "[↑↓] select  [f] filter  [Tab] details  [d/a/y/t/p/g] screens  [s] reply  [a] accept  [b] block  [c/x] complete  [P] approve  [J] changes  [E] reopen  [Enter] thread  [Esc] dashboard  [q] quit",
      cols,
    );
    const viewportHeight = rows - header.length - 2;
    const twoPane = cols >= 110 && this.dashboardState.detailsSidebarVisible;
    const listLines: string[] = [];

    if (this.workflowEntries.length === 0) {
      listLines.push("  Workflow");
      listLines.push("    No open task/review/handoff workflow items.");
    } else {
      listLines.push("  Workflow");
      for (let i = 0; i < this.workflowEntries.length; i++) {
        const entry = this.workflowEntries[i]!;
        const selected = i === this.workflowIndex;
        const marker = selected ? "\x1b[33m▸\x1b[0m " : "  ";
        const pending = entry.pendingDeliveries > 0 ? ` \x1b[31m⇢ ${entry.pendingDeliveries}\x1b[0m` : "";
        const unread =
          (entry.thread.unreadBy?.length ?? 0) > 0 ? ` \x1b[36m${entry.thread.unreadBy!.length}\x1b[0m` : "";
        const family = entry.familyTaskIds.length > 1 ? ` \x1b[35m⤳${entry.familyTaskIds.length}\x1b[0m` : "";
        const latest = entry.latestMessage?.body
          ? ` \x1b[2m· ${this.truncatePlain(entry.latestMessage.body, 28)}\x1b[0m`
          : "";
        listLines.push(
          `${marker}[${i + 1}] ${entry.displayTitle} \x1b[2m(${entry.thread.kind})\x1b[0m — ${entry.stateLabel}${family}${unread}${pending}${latest}${selected ? " \x1b[33m◀\x1b[0m" : ""}`,
        );
      }
    }

    const focusLine = this.workflowEntries.length === 0 ? 1 : this.workflowIndex + 1;
    const body = this.composeSplitScreen(
      listLines,
      this.renderWorkflowDetails(Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
      cols,
      viewportHeight,
      focusLine,
      twoPane,
    );
    process.stdout.write(
      "\x1b[2J\x1b[H" +
        [...header, ...body, this.centerInWidth("─".repeat(Math.min(cols - 4, 72)), cols), footer].join("\r\n"),
    );
  }

  private renderWorkflowDetails(width: number, height: number): string[] {
    const entry = this.workflowEntries[this.workflowIndex];
    if (!entry) return new Array(height).fill("");
    const lines: string[] = [];
    lines.push("\x1b[1mWorkflow\x1b[0m");
    lines.push(...this.wrapKeyValue("Title", entry.displayTitle, width));
    lines.push(...this.wrapKeyValue("Kind", entry.thread.kind, width));
    lines.push(...this.wrapKeyValue("State", entry.stateLabel, width));
    if (entry.task) {
      lines.push(...this.wrapKeyValue("Task Status", entry.task.status, width));
      if (entry.task.type === "review" && entry.task.reviewStatus) {
        lines.push(...this.wrapKeyValue("Review", entry.task.reviewStatus, width));
      }
      if (entry.familyTaskIds.length > 1) {
        lines.push(...this.wrapKeyValue("Workflow Root", entry.familyRootTaskId ?? entry.task.id, width));
        lines.push(...this.wrapKeyValue("Chain Size", String(entry.familyTaskIds.length), width));
        lines.push(...this.wrapKeyValue("Chain", entry.familyTaskIds.join(" → "), width));
      }
      lines.push(...this.wrapKeyValue("Prompt", entry.task.prompt, width));
      if (entry.task.result) lines.push(...this.wrapKeyValue("Result", entry.task.result, width));
      if (entry.task.error) lines.push(...this.wrapKeyValue("Error", entry.task.error, width));
    }
    if (entry.thread.owner) lines.push(...this.wrapKeyValue("Owner", entry.thread.owner, width));
    if ((entry.thread.waitingOn?.length ?? 0) > 0) {
      lines.push(...this.wrapKeyValue("Waiting On", entry.thread.waitingOn!.join(", "), width));
    }
    if (entry.pendingDeliveries > 0) {
      lines.push(...this.wrapKeyValue("Pending Delivery", entry.latestPendingRecipients.join(", "), width));
    }
    if (entry.thread.taskId) lines.push(...this.wrapKeyValue("Task", entry.thread.taskId, width));
    lines.push("");
    lines.push("\x1b[1mLatest\x1b[0m");
    if (entry.latestMessage) {
      lines.push(
        ...this.wrapKeyValue(
          `${entry.latestMessage.from} [${entry.latestMessage.kind}]`,
          entry.latestMessage.body,
          width,
        ),
      );
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private handleWorkflowKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const key = events[0].name || events[0].char;

    if (key === "tab") {
      this.dashboardState.toggleDetailsSidebar();
      this.renderWorkflow();
      return;
    }
    if (key === "q") {
      this.tmuxRuntimeManager.leaveManagedSession({
        insideTmux: this.tmuxRuntimeManager.isInsideTmux(),
        sessionName: this.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
      });
      this.cleanup();
      process.exit(0);
      return;
    }
    if (key === "escape" || key === "d") {
      this.setDashboardScreen("dashboard");
      this.renderDashboard();
      return;
    }
    if (this.handleDashboardSubscreenNavigationKey(key, "workflow")) return;
    if (key === "?") {
      this.showHelp();
      return;
    }
    if (key === "f") {
      this.cycleWorkflowFilter();
      return;
    }
    if (key === "s") {
      const entry = this.workflowEntries[this.workflowIndex];
      if (entry) {
        this.threadEntries = buildThreadEntries();
        this.threadIndex = Math.max(
          0,
          this.threadEntries.findIndex((thread) => thread.thread.id === entry.thread.id),
        );
        this.threadReplyActive = true;
        this.threadReplyBuffer = "";
        this.setDashboardScreen("threads");
        this.renderThreadReply();
      }
      return;
    }
    if (key === "a" || key === "c" || key === "b" || key === "o" || key === "x") {
      const entry = this.workflowEntries[this.workflowIndex];
      if (!entry) return;
      if (entry.task) {
        if (key === "a") {
          void this.runTaskLifecycleAction("accept", entry.task.id);
          return;
        }
        if (key === "b") {
          void this.runTaskLifecycleAction("block", entry.task.id);
          return;
        }
        if (key === "c" || key === "x") {
          void this.runTaskLifecycleAction("complete", entry.task.id);
          return;
        }
      }
      if (key === "a" && entry.thread.kind === "handoff") {
        void this.runThreadHandoffAction("accept", entry.thread.id);
        return;
      }
      if (key === "c" && entry.thread.kind === "handoff") {
        void this.runThreadHandoffAction("complete", entry.thread.id);
        return;
      }
      const statusMap: Record<string, ThreadStatus> = { b: "blocked", o: "open", x: "done" };
      const status = statusMap[key];
      if (status) {
        void this.runThreadStatusAction(entry.thread.id, status);
      }
      return;
    }
    if (key === "P" || key === "J" || key === "E") {
      const entry = this.workflowEntries[this.workflowIndex];
      if (!entry?.task) return;
      if (key === "P") {
        void this.runReviewLifecycleAction("approve", entry.task.id);
        return;
      }
      if (key === "J") {
        void this.runReviewLifecycleAction("request_changes", entry.task.id);
        return;
      }
      if (key === "E") {
        void this.runTaskLifecycleAction("reopen", entry.task.id);
      }
      return;
    }
    if (key === "down" || key === "j" || key === "n") {
      if (this.workflowEntries.length > 1) {
        this.workflowIndex = (this.workflowIndex + 1) % this.workflowEntries.length;
        this.renderWorkflow();
      }
      return;
    }
    if (key === "up" || key === "k") {
      if (this.workflowEntries.length > 1) {
        this.workflowIndex = (this.workflowIndex - 1 + this.workflowEntries.length) % this.workflowEntries.length;
        this.renderWorkflow();
      }
      return;
    }
    if (key >= "1" && key <= "9") {
      const idx = parseInt(key, 10) - 1;
      if (idx < this.workflowEntries.length) {
        this.workflowIndex = idx;
        this.renderWorkflow();
      }
      return;
    }
    if (key === "enter" || key === "return") {
      const entry = this.workflowEntries[this.workflowIndex];
      if (!entry) return;
      this.threadEntries = buildThreadEntries();
      this.threadIndex = Math.max(
        0,
        this.threadEntries.findIndex((thread) => thread.thread.id === entry.thread.id),
      );
      this.setDashboardScreen("threads");
      this.renderThreads();
    }
  }

  private renderActivityDashboard(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const header: string[] = [];
    header.push("");
    header.push(this.centerInWidth("\x1b[1maimux\x1b[0m — activity", cols));
    header.push(this.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
    header.push("");
    const footer = this.centerInWidth(
      "[↑↓] select  [Tab] details  [d/a/y/t/p/g] screens  [1-9/Enter] focus  [u] next attention  [Esc] dashboard  [q] quit",
      cols,
    );
    const viewportHeight = rows - header.length - 2;
    const twoPane = cols >= 110 && this.dashboardState.detailsSidebarVisible;
    const listLines: string[] = [];

    if (this.activityEntries.length === 0) {
      listLines.push("  Activity");
      listLines.push("    No sessions currently need attention.");
    } else {
      listLines.push("  Activity");
      for (let i = 0; i < this.activityEntries.length; i++) {
        const entry = this.activityEntries[i]!;
        const selected = i === this.activityIndex;
        const marker = selected ? "\x1b[33m▸\x1b[0m " : "  ";
        const identity = entry.label ?? entry.command;
        const roleTag = entry.role ? ` \x1b[36m(${entry.role})\x1b[0m` : "";
        const wt = entry.worktreeName
          ? ` \x1b[2m· ${this.truncatePlain(entry.worktreeName, 18)}${entry.worktreeBranch ? `@${this.truncatePlain(entry.worktreeBranch, 18)}` : ""}\x1b[0m`
          : "";
        const state =
          entry.attention && entry.attention !== "normal" ? entry.attention : (entry.activity ?? entry.status);
        const unseen = (entry.unseenCount ?? 0) > 0 ? ` \x1b[36m${entry.unseenCount}\x1b[0m` : "";
        const service = entry.services?.[0]
          ? ` \x1b[2m· ${entry.services[0].port ? `:${entry.services[0].port}` : this.truncatePlain(entry.services[0].url ?? "", 16)}\x1b[0m`
          : "";
        listLines.push(
          `${marker}[${i + 1}] ${identity}${roleTag} — ${state}${unseen}${wt}${service}${selected ? " \x1b[33m◀\x1b[0m" : ""}`,
        );
      }
    }

    const focusLine = this.activityEntries.length === 0 ? 1 : this.activityIndex + 1;
    const body = this.composeSplitScreen(
      listLines,
      this.renderSessionDetails(
        this.activityEntries[this.activityIndex],
        Math.max(28, cols - Math.floor(cols * 0.56) - 3),
        viewportHeight,
      ),
      cols,
      viewportHeight,
      focusLine,
      twoPane,
    );
    process.stdout.write(
      "\x1b[2J\x1b[H" +
        [...header, ...body, this.centerInWidth("─".repeat(Math.min(cols - 4, 72)), cols), footer].join("\r\n"),
    );
  }

  private handleActivityKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const key = events[0].name || events[0].char;

    if (key === "tab") {
      this.dashboardState.toggleDetailsSidebar();
      this.renderActivityDashboard();
      return;
    }

    if (key === "q") {
      this.tmuxRuntimeManager.leaveManagedSession({
        insideTmux: this.tmuxRuntimeManager.isInsideTmux(),
        sessionName: this.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
      });
      this.cleanup();
      process.exit(0);
      return;
    }

    if (key === "escape" || key === "d") {
      this.setDashboardScreen("dashboard");
      this.renderDashboard();
      return;
    }
    if (this.handleDashboardSubscreenNavigationKey(key, "activity")) return;
    if (key === "?") {
      this.showHelp();
      return;
    }
    if (key === "u") {
      void this.activateNextAttentionEntry();
      return;
    }
    if (key === "down" || key === "j" || key === "n") {
      if (this.activityEntries.length > 1) {
        this.activityIndex = (this.activityIndex + 1) % this.activityEntries.length;
        this.renderActivityDashboard();
      }
      return;
    }
    if (key === "up" || key === "k") {
      if (this.activityEntries.length > 1) {
        this.activityIndex = (this.activityIndex - 1 + this.activityEntries.length) % this.activityEntries.length;
        this.renderActivityDashboard();
      }
      return;
    }
    if (key >= "1" && key <= "9") {
      const idx = parseInt(key, 10) - 1;
      const entry = this.activityEntries[idx];
      if (entry) void this.activateDashboardEntry(entry);
      return;
    }
    if (key === "enter" || key === "return") {
      const entry = this.activityEntries[this.activityIndex];
      if (entry) void this.activateDashboardEntry(entry);
    }
  }

  private showThreads(): void {
    this.clearDashboardSubscreens();
    this.threadEntries = buildThreadEntries();
    if (this.threadIndex >= this.threadEntries.length) {
      this.threadIndex = Math.max(0, this.threadEntries.length - 1);
    }
    this.setDashboardScreen("threads");
    this.writeStatuslineFile();
    this.renderThreads();
  }

  private getPreferredThreadIndexForParticipant(participantId: string, entries: ThreadEntry[]): number {
    const participantEntries = entries.filter((entry) => entry.thread.participants.includes(participantId));
    const targetEntries = participantEntries;
    if (targetEntries.length === 0) return -1;
    const scored = targetEntries
      .map((entry) => {
        const waitingOnMe = (entry.thread.waitingOn ?? []).includes(participantId) ? 3 : 0;
        const unread = (entry.thread.unreadBy ?? []).includes(participantId) ? 2 : 0;
        const ownsWaiting = entry.thread.owner === participantId && (entry.thread.waitingOn?.length ?? 0) > 0 ? 1 : 0;
        return { entry, score: waitingOnMe + unread + ownsWaiting };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.entry.thread.updatedAt < b.entry.thread.updatedAt
            ? 1
            : a.entry.thread.updatedAt > b.entry.thread.updatedAt
              ? -1
              : 0),
      );
    const targetId = scored[0]!.entry.thread.id;
    return entries.findIndex((entry) => entry.thread.id === targetId);
  }

  private openRelevantThreadForSession(sessionId: string): void {
    const entries = buildThreadEntries();
    const idx = this.getPreferredThreadIndexForParticipant(sessionId, entries);
    if (idx < 0 || idx >= entries.length) {
      this.footerFlash = `No thread for ${sessionId}`;
      this.footerFlashTicks = 3;
      this.renderDashboard();
      return;
    }
    this.threadEntries = entries;
    this.threadIndex = idx;
    this.setDashboardScreen("threads");
    this.writeStatuslineFile();
    const entry = this.threadEntries[this.threadIndex];
    if (entry && (entry.thread.waitingOn ?? []).includes(sessionId)) {
      this.threadReplyActive = true;
      this.threadReplyBuffer = "";
      this.renderThreadReply();
      return;
    }
    this.renderThreads();
  }

  private renderThreads(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const header: string[] = [];
    header.push("");
    header.push(this.centerInWidth("\x1b[1maimux\x1b[0m — threads", cols));
    header.push(this.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
    header.push("");
    const footer = this.centerInWidth(
      "[↑↓] select  [Tab] details  [d/a/y/t/p/g] screens  [s] reply  [a] accept  [c] complete  [b/o/x] state  [Enter] jump  [r] refresh  [Esc] dashboard  [q] quit",
      cols,
    );
    const viewportHeight = rows - header.length - 2;
    const twoPane = cols >= 110 && this.dashboardState.detailsSidebarVisible;
    const listLines: string[] = [];

    if (this.threadEntries.length === 0) {
      listLines.push("  Threads");
      listLines.push("    No orchestration threads yet.");
    } else {
      listLines.push("  Threads");
      for (let i = 0; i < this.threadEntries.length; i++) {
        const entry = this.threadEntries[i]!;
        const selected = i === this.threadIndex;
        const marker = selected ? "\x1b[33m▸\x1b[0m " : "  ";
        const unread =
          (entry.thread.unreadBy?.length ?? 0) > 0 ? ` \x1b[36m${entry.thread.unreadBy!.length}\x1b[0m` : "";
        const waiting =
          (entry.thread.waitingOn?.length ?? 0) > 0 ? ` \x1b[35m→ ${entry.thread.waitingOn!.join(",")}\x1b[0m` : "";
        const pending = entry.pendingDeliveries > 0 ? ` \x1b[31m⇢ ${entry.pendingDeliveries}\x1b[0m` : "";
        const latest = entry.latestMessage?.body
          ? ` \x1b[2m· ${this.truncatePlain(entry.latestMessage.body, 34)}\x1b[0m`
          : "";
        listLines.push(
          `${marker}[${i + 1}] ${entry.displayTitle} \x1b[2m(${entry.thread.kind})\x1b[0m — ${entry.thread.status}${unread}${waiting}${pending}${latest}${selected ? " \x1b[33m◀\x1b[0m" : ""}`,
        );
      }
    }

    const focusLine = this.threadEntries.length === 0 ? 1 : this.threadIndex + 1;
    const body = this.composeSplitScreen(
      listLines,
      this.renderThreadDetails(Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
      cols,
      viewportHeight,
      focusLine,
      twoPane,
    );
    process.stdout.write(
      "\x1b[2J\x1b[H" +
        [...header, ...body, this.centerInWidth("─".repeat(Math.min(cols - 4, 72)), cols), footer].join("\r\n"),
    );
  }

  private renderThreadDetails(width: number, height: number): string[] {
    const entry = this.threadEntries[this.threadIndex];
    if (!entry) return new Array(height).fill("");
    const lines: string[] = [];
    lines.push("\x1b[1mDetails\x1b[0m");
    lines.push(...this.wrapKeyValue("Title", entry.displayTitle, width));
    lines.push(...this.wrapKeyValue("Kind", entry.thread.kind, width));
    lines.push(...this.wrapKeyValue("Status", entry.thread.status, width));
    lines.push(...this.wrapKeyValue("Created By", entry.thread.createdBy, width));
    lines.push(...this.wrapKeyValue("Participants", entry.thread.participants.join(", "), width));
    if (entry.thread.owner) lines.push(...this.wrapKeyValue("Owner", entry.thread.owner, width));
    if (entry.thread.kind === "handoff") {
      lines.push(...this.wrapKeyValue("Handoff", this.describeHandoffState(entry.thread), width));
    }
    if ((entry.thread.waitingOn?.length ?? 0) > 0) {
      lines.push(...this.wrapKeyValue("Waiting On", entry.thread.waitingOn!.join(", "), width));
    }
    if ((entry.thread.unreadBy?.length ?? 0) > 0) {
      lines.push(...this.wrapKeyValue("Unread By", entry.thread.unreadBy!.join(", "), width));
    }
    if (entry.pendingDeliveries > 0) {
      lines.push(...this.wrapKeyValue("Pending Delivery", entry.latestPendingRecipients.join(", "), width));
    }
    if (entry.thread.taskId) lines.push(...this.wrapKeyValue("Task", entry.thread.taskId, width));
    if (entry.thread.worktreePath) lines.push(...this.wrapKeyValue("Worktree", entry.thread.worktreePath, width));
    lines.push("");
    lines.push("\x1b[1mMessages\x1b[0m");
    const messages = readMessages(entry.thread.id).slice(-Math.max(3, height - lines.length));
    for (const message of messages) {
      const prefix = `${message.from}${message.to?.length ? ` → ${message.to.join(", ")}` : ""} [${message.kind}]`;
      const delivered = message.deliveredTo ?? [];
      const pending = (message.to ?? []).filter((recipient) => !(message.deliveredTo ?? []).includes(recipient));
      const statusParts: string[] = [];
      if (delivered.length > 0) {
        statusParts.push(
          pending.length > 0 ? `delivered ${delivered.join(", ")}` : `delivered to ${delivered.join(", ")}`,
        );
      }
      if (pending.length > 0) {
        statusParts.push(`pending ${pending.join(", ")}`);
      }
      const suffix = statusParts.length > 0 ? ` (${statusParts.join("; ")})` : "";
      lines.push(...this.wrapKeyValue(prefix, `${message.body}${suffix}`, width));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private handleThreadsKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const key = events[0].name || events[0].char;

    if (key === "tab") {
      this.dashboardState.toggleDetailsSidebar();
      this.renderThreads();
      return;
    }
    if (key === "q") {
      this.tmuxRuntimeManager.leaveManagedSession({
        insideTmux: this.tmuxRuntimeManager.isInsideTmux(),
        sessionName: this.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
      });
      this.cleanup();
      process.exit(0);
      return;
    }
    if (key === "escape" || key === "d") {
      this.setDashboardScreen("dashboard");
      this.renderDashboard();
      return;
    }
    if (this.handleDashboardSubscreenNavigationKey(key, "threads")) return;
    if (key === "?") {
      this.showHelp();
      return;
    }
    if (key === "r") {
      this.threadEntries = buildThreadEntries();
      if (this.threadIndex >= this.threadEntries.length) {
        this.threadIndex = Math.max(0, this.threadEntries.length - 1);
      }
      this.renderThreads();
      return;
    }
    if (key === "s") {
      if (this.threadEntries[this.threadIndex]) {
        this.threadReplyActive = true;
        this.threadReplyBuffer = "";
        this.renderThreadReply();
      }
      return;
    }
    if (key === "a") {
      const entry = this.threadEntries[this.threadIndex];
      if (entry?.thread.kind === "handoff") {
        void this.runThreadHandoffAction("accept", entry.thread.id);
      }
      return;
    }
    if (key === "c") {
      const entry = this.threadEntries[this.threadIndex];
      if (entry?.thread.kind === "handoff") {
        void this.runThreadHandoffAction("complete", entry.thread.id);
      }
      return;
    }
    if (key === "b") {
      const entry = this.threadEntries[this.threadIndex];
      if (entry) {
        void this.runThreadStatusAction(entry.thread.id, "blocked");
      }
      return;
    }
    if (key === "o") {
      const entry = this.threadEntries[this.threadIndex];
      if (entry) {
        void this.runThreadStatusAction(entry.thread.id, "open");
      }
      return;
    }
    if (key === "x") {
      const entry = this.threadEntries[this.threadIndex];
      if (entry) {
        void this.runThreadStatusAction(entry.thread.id, "done");
      }
      return;
    }
    if (key === "down" || key === "j" || key === "n") {
      if (this.threadEntries.length > 1) {
        this.threadIndex = (this.threadIndex + 1) % this.threadEntries.length;
        this.renderThreads();
      }
      return;
    }
    if (key === "up" || key === "k") {
      if (this.threadEntries.length > 1) {
        this.threadIndex = (this.threadIndex - 1 + this.threadEntries.length) % this.threadEntries.length;
        this.renderThreads();
      }
      return;
    }
    if (key >= "1" && key <= "9") {
      const idx = parseInt(key, 10) - 1;
      if (idx < this.threadEntries.length) {
        this.threadIndex = idx;
        this.renderThreads();
      }
      return;
    }
    if (key === "enter" || key === "return") {
      const entry = this.threadEntries[this.threadIndex];
      if (!entry) return;
      const targetSessionId = entry.thread.owner ?? entry.thread.waitingOn?.[0] ?? entry.thread.participants[0];
      if (targetSessionId) {
        markThreadSeen(entry.thread.id, targetSessionId);
        const dashEntry = this.getDashboardSessions().find((session) => session.id === targetSessionId);
        if (dashEntry) {
          void this.activateDashboardEntry(dashEntry);
        }
      }
    }
  }

  private renderThreadReply(): void {
    const entry = this.threadEntries[this.threadIndex];
    if (!entry) return;
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const targets =
      entry.thread.waitingOn?.length && entry.thread.waitingOn.length > 0
        ? entry.thread.waitingOn
        : entry.thread.participants.filter((participant) => participant !== "user");
    const title = this.truncatePlain(entry.displayTitle, Math.max(16, cols - 24));
    const buffer = this.truncatePlain(this.threadReplyBuffer, Math.max(12, cols - 24));
    const lines = [
      "Reply in thread:",
      "",
      `  Thread: ${title}`,
      `  To: ${targets.join(", ") || "participants"}`,
      "",
      `  Message: ${buffer}_`,
      "",
      "  [Enter] send  [Esc] cancel",
    ];
    const boxWidth = Math.max(...lines.map((line) => this.stripAnsi(line).length)) + 4;
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
    process.stdout.write(output);
  }

  private describeHandoffState(thread: OrchestrationThread): string {
    if (thread.status === "done") {
      return `completed by ${thread.owner ?? "unknown"}`;
    }
    if ((thread.waitingOn?.length ?? 0) > 0) {
      return `${thread.owner ?? thread.createdBy} waiting on ${thread.waitingOn!.join(", ")}`;
    }
    if (thread.owner && thread.owner !== thread.createdBy) {
      return `accepted by ${thread.owner}`;
    }
    return `awaiting acceptance from ${thread.participants.filter((id) => id !== thread.createdBy).join(", ") || "recipient"}`;
  }

  private async runThreadHandoffAction(mode: "accept" | "complete", threadId: string): Promise<void> {
    try {
      if (mode === "accept") {
        await this.postToProjectService("/handoff/accept", {
          threadId,
          from: "user",
        });
        this.footerFlash = "⇢ Handoff accepted";
      } else {
        await this.postToProjectService("/handoff/complete", {
          threadId,
          from: "user",
        });
        this.footerFlash = "⇢ Handoff completed";
      }
      this.footerFlashTicks = 3;
    } catch {
      try {
        if (mode === "accept") {
          acceptHandoff({ threadId, from: "user" });
          this.footerFlash = "⇢ Handoff accepted";
        } else {
          completeHandoff({ threadId, from: "user" });
          this.footerFlash = "⇢ Handoff completed";
        }
        this.footerFlashTicks = 3;
      } catch (error) {
        this.showDashboardError(`Failed to ${mode} handoff`, [error instanceof Error ? error.message : String(error)]);
        return;
      }
    }
    this.threadEntries = buildThreadEntries();
    this.threadIndex = Math.min(this.threadIndex, Math.max(0, this.threadEntries.length - 1));
    this.renderThreads();
  }

  private async runThreadStatusAction(threadId: string, status: ThreadStatus): Promise<void> {
    try {
      await this.postToProjectService("/threads/status", {
        threadId,
        status,
      });
      this.footerFlash = `Thread marked ${status}`;
      this.footerFlashTicks = 3;
    } catch {
      try {
        setThreadStatus(threadId, status);
        this.footerFlash = `Thread marked ${status}`;
        this.footerFlashTicks = 3;
      } catch (error) {
        this.showDashboardError("Failed to update thread status", [
          error instanceof Error ? error.message : String(error),
        ]);
        return;
      }
    }
    this.threadEntries = buildThreadEntries();
    this.threadIndex = Math.min(this.threadIndex, Math.max(0, this.threadEntries.length - 1));
    this.renderThreads();
  }

  private async runTaskLifecycleAction(
    mode: "accept" | "block" | "complete" | "reopen",
    taskId: string,
  ): Promise<void> {
    try {
      if (mode === "accept") {
        await this.postToProjectService("/tasks/accept", { taskId, from: "user" });
        this.footerFlash = "⧫ Task accepted";
      } else if (mode === "block") {
        await this.postToProjectService("/tasks/block", { taskId, from: "user" });
        this.footerFlash = "⧫ Task blocked";
      } else if (mode === "reopen") {
        await this.postToProjectService("/tasks/reopen", { taskId, from: "user" });
        this.footerFlash = "↺ Task reopened";
      } else {
        await this.postToProjectService("/tasks/complete", { taskId, from: "user" });
        this.footerFlash = "✓ Task completed";
      }
      this.footerFlashTicks = 3;
    } catch {
      try {
        if (mode === "accept") {
          await acceptTask({ taskId, from: "user" });
          this.footerFlash = "⧫ Task accepted";
        } else if (mode === "block") {
          await blockTask({ taskId, from: "user" });
          this.footerFlash = "⧫ Task blocked";
        } else if (mode === "reopen") {
          await reopenTask({ taskId, from: "user" });
          this.footerFlash = "↺ Task reopened";
        } else {
          await completeTask({ taskId, from: "user" });
          this.footerFlash = "✓ Task completed";
        }
        this.footerFlashTicks = 3;
      } catch (error) {
        this.showDashboardError(`Failed to ${mode} task`, [error instanceof Error ? error.message : String(error)]);
        return;
      }
    }
    this.workflowEntries = this.buildWorkflowEntries();
    this.workflowIndex = Math.min(this.workflowIndex, Math.max(0, this.workflowEntries.length - 1));
    this.renderWorkflow();
  }

  private async runReviewLifecycleAction(mode: "approve" | "request_changes", taskId: string): Promise<void> {
    try {
      if (mode === "approve") {
        await this.postToProjectService("/reviews/approve", { taskId, from: "user" });
        this.footerFlash = "✓ Review approved";
      } else {
        await this.postToProjectService("/reviews/request-changes", { taskId, from: "user" });
        this.footerFlash = "↺ Changes requested";
      }
      this.footerFlashTicks = 3;
    } catch {
      try {
        if (mode === "approve") {
          await approveReview({ taskId, from: "user" });
          this.footerFlash = "✓ Review approved";
        } else {
          await requestTaskChanges({ taskId, from: "user" });
          this.footerFlash = "↺ Changes requested";
        }
        this.footerFlashTicks = 3;
      } catch (error) {
        this.showDashboardError(`Failed to ${mode === "approve" ? "approve review" : "request changes"}`, [
          error instanceof Error ? error.message : String(error),
        ]);
        return;
      }
    }
    this.workflowEntries = this.buildWorkflowEntries();
    this.workflowIndex = Math.min(this.workflowIndex, Math.max(0, this.workflowEntries.length - 1));
    this.renderWorkflow();
  }

  private describeWorkflowFilter(): string {
    if (this.workflowFilter === "on_me") return "waiting on me";
    if (this.workflowFilter === "blocked") return "blocked";
    if (this.workflowFilter === "families") return "families";
    return "all";
  }

  private cycleWorkflowFilter(): void {
    const order: WorkflowFilter[] = ["all", "on_me", "blocked", "families"];
    const current = order.indexOf(this.workflowFilter);
    this.workflowFilter = order[(current + 1) % order.length] ?? "all";
    this.workflowEntries = this.buildWorkflowEntries();
    this.workflowIndex = Math.min(this.workflowIndex, Math.max(0, this.workflowEntries.length - 1));
    this.footerFlash = `Workflow filter: ${this.describeWorkflowFilter()}`;
    this.footerFlashTicks = 3;
    this.renderWorkflow();
  }

  private handleThreadReplyKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const event = events[0];
    const key = event.name || event.char;

    if (key === "escape") {
      this.threadReplyActive = false;
      this.threadReplyBuffer = "";
      this.renderThreads();
      return;
    }

    if (key === "enter" || key === "return") {
      const body = this.threadReplyBuffer.trim();
      const entry = this.threadEntries[this.threadIndex];
      this.threadReplyActive = false;
      this.threadReplyBuffer = "";
      if (!entry || !body) {
        this.renderThreads();
        return;
      }
      try {
        this.sendOrchestrationMessage({
          threadId: entry.thread.id,
          from: "user",
          kind: "reply",
          body,
        });
      } catch (error) {
        this.showDashboardError("Failed to reply in thread", [error instanceof Error ? error.message : String(error)]);
        return;
      }
      this.threadEntries = buildThreadEntries();
      this.threadIndex = Math.min(this.threadIndex, Math.max(0, this.threadEntries.length - 1));
      this.renderThreads();
      return;
    }

    if (key === "backspace" || key === "delete") {
      this.threadReplyBuffer = this.threadReplyBuffer.slice(0, -1);
      this.renderThreadReply();
      return;
    }

    if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
      this.threadReplyBuffer += event.char;
      this.renderThreadReply();
    }
  }

  private async activateNextAttentionEntry(): Promise<void> {
    const ordered = this.getDashboardSessionsInVisualOrder()
      .map((entry, index) => ({ entry, index, score: this.attentionScore(entry) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    if (ordered.length === 0) return;

    const currentSessionId =
      this.dashboardState.level === "sessions" && this.dashboardState.worktreeSessions.length > 0
        ? this.dashboardState.worktreeSessions[this.dashboardState.sessionIndex]?.id
        : this.getDashboardSessions()[this.activeIndex]?.id;
    const currentIdx = currentSessionId ? ordered.findIndex((entry) => entry.entry.id === currentSessionId) : -1;
    const next = ordered[currentIdx >= 0 ? (currentIdx + 1) % ordered.length : 0]!;
    await this.activateDashboardEntryByNumber(next.index);
  }

  /** Get sessions belonging to the focused worktree (includes local, remote, offline) */
  private updateWorktreeSessions(): void {
    const allDash = this.getDashboardSessions();
    this.dashboardState.worktreeSessions = allDash.filter((s) => {
      return (s.worktreePath ?? undefined) === this.dashboardState.focusedWorktreePath;
    });
  }

  private isDashboardScreen(screen: DashboardScreen): boolean {
    return this.dashboardState.isScreen(screen);
  }

  private setDashboardScreen(screen: DashboardScreen): void {
    this.dashboardState.setScreen(screen);
  }

  private handleActiveDashboardOverlayKey(data: Buffer): boolean {
    if (this.dashboardBusyState) {
      return true;
    }
    if (this.dashboardErrorState) {
      const events = parseKeys(data);
      if (events.length === 0) return true;
      const key = events[0].name || events[0].char;
      if (key === "escape" || key === "enter" || key === "return") {
        this.dismissDashboardError();
      }
      return true;
    }
    if (this.pickerActive) {
      this.handleToolPickerKey(data);
      return true;
    }
    if (this.worktreeRemoveConfirm) {
      this.handleWorktreeRemoveConfirmKey(data);
      return true;
    }
    if (this.worktreeInputActive) {
      this.handleWorktreeInputKey(data);
      return true;
    }
    if (this.worktreeListActive) {
      this.handleWorktreeListKey(data);
      return true;
    }
    if (this.migratePickerActive) {
      this.handleMigratePickerKey(data);
      return true;
    }
    if (this.switcherActive) {
      this.handleSwitcherKey(data);
      return true;
    }
    if (this.threadReplyActive) {
      this.handleThreadReplyKey(data);
      return true;
    }
    if (this.orchestrationRoutePickerActive) {
      this.handleOrchestrationRoutePickerKey(data);
      return true;
    }
    if (this.orchestrationInputActive) {
      this.handleOrchestrationInputKey(data);
      return true;
    }
    if (this.labelInputActive) {
      this.handleLabelInputKey(data);
      return true;
    }
    return false;
  }

  private renderActiveDashboardOverlay(): boolean {
    if (this.worktreeRemoveConfirm) {
      this.renderWorktreeRemoveConfirm();
      return true;
    }
    if (this.dashboardErrorState) {
      this.renderDashboardErrorOverlay();
      return true;
    }
    if (this.dashboardBusyState) {
      this.renderDashboardBusyOverlay();
      return true;
    }
    if (this.switcherActive) {
      this.renderSwitcher();
      return true;
    }
    if (this.threadReplyActive) {
      this.renderThreadReply();
      return true;
    }
    if (this.orchestrationInputActive) {
      this.renderOrchestrationInput();
      return true;
    }
    if (this.migratePickerActive) {
      this.renderMigratePicker();
      return true;
    }
    if (this.worktreeListActive) {
      this.renderWorktreeList();
      return true;
    }
    if (this.labelInputActive) {
      this.renderLabelInput();
      return true;
    }
    if (this.worktreeInputActive) {
      this.renderWorktreeInput();
      return true;
    }
    if (this.pickerActive) {
      this.renderToolPicker();
      return true;
    }
    if (this.orchestrationRoutePickerActive) {
      this.renderOrchestrationRoutePicker();
      return true;
    }
    return false;
  }

  private handleDashboardSubscreenNavigationKey(
    key: string,
    currentScreen: Exclude<DashboardScreen, "dashboard">,
  ): boolean {
    if (key === "d") {
      this.setDashboardScreen("dashboard");
      this.renderDashboard();
      return true;
    }
    if (key === "a") {
      if (currentScreen === "activity") {
        this.renderActivityDashboard();
      } else {
        this.showActivityDashboard();
      }
      return true;
    }
    if (key === "t") {
      if (currentScreen === "threads") {
        this.renderThreads();
      } else {
        this.showThreads();
      }
      return true;
    }
    if (key === "y") {
      if (currentScreen === "workflow") {
        this.renderWorkflow();
      } else {
        this.showWorkflow();
      }
      return true;
    }
    if (key === "p") {
      if (currentScreen === "plans") {
        this.renderPlans();
      } else {
        this.showPlans();
      }
      return true;
    }
    if (key === "g") {
      if (currentScreen === "graveyard") {
        this.renderGraveyard();
      } else {
        this.showGraveyard();
      }
      return true;
    }
    return false;
  }

  private openLiveTmuxWindowForEntry(entry: { id: string; backendSessionId?: string }): boolean {
    const tmuxSession = this.tmuxRuntimeManager.getProjectSession(process.cwd());
    const match = this.tmuxRuntimeManager.findManagedWindow(tmuxSession.sessionName, {
      sessionId: entry.id,
      backendSessionId: entry.backendSessionId,
    });
    if (!match) return false;
    this.agentTracker.markSeen(entry.id);
    this.tmuxRuntimeManager.openTarget(match.target, { insideTmux: this.tmuxRuntimeManager.isInsideTmux() });
    return true;
  }

  private getSelectedDashboardSessionForActions(): DashboardSession | undefined {
    if (this.dashboardState.level === "sessions" && this.dashboardState.worktreeSessions.length > 0) {
      return this.dashboardState.worktreeSessions[this.dashboardState.sessionIndex];
    }
    if (this.dashboardState.worktreeNavOrder.length <= 1) {
      return this.getDashboardSessions()[this.activeIndex];
    }
    return undefined;
  }

  private showOrchestrationRoutePicker(mode: "message" | "handoff" | "task"): void {
    const selected = this.getSelectedDashboardSessionForActions();
    const options: DashboardOrchestrationTarget[] = [];
    const focusedWorktreePath = this.mode === "dashboard" ? this.dashboardState.focusedWorktreePath : undefined;
    const metadataState = loadMetadataState().sessions;
    const candidates = this.sessions.map((session) => ({
      id: session.id,
      tool: this.sessionToolKeys.get(session.id) ?? session.command,
      role: this.sessionRoles.get(session.id),
      worktreePath: this.sessionWorktreePaths.get(session.id),
      status: metadataState[session.id]?.derived?.activity,
      exited: session.exited,
    }));

    if (selected && !selected.remoteInstancePid) {
      options.push({
        label: `${selected.label ?? selected.command ?? selected.id} (${selected.id})`,
        sessionId: selected.id,
      });
    }

    const team = loadTeamConfig();
    for (const [role, cfg] of Object.entries(team.roles)) {
      const recipientIds = resolveOrchestrationRecipients({
        candidates,
        assignee: role,
        worktreePath: focusedWorktreePath,
      });
      if (recipientIds.length === 0) continue;
      options.push({
        label: `Role: ${role}${cfg.description ? ` — ${cfg.description}` : ""}${this.formatRoutePreview(recipientIds)}`,
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
        label: `Tool: ${toolKey}${this.formatRoutePreview(recipientIds)}`,
        tool: toolKey,
        worktreePath: focusedWorktreePath,
        recipientIds,
      });
    }

    if (options.length === 0) {
      this.showDashboardError("No orchestration targets available", [
        "Select a local agent, define team roles, or enable tools before sending orchestration actions.",
      ]);
      return;
    }

    this.orchestrationRouteMode = mode;
    this.orchestrationRouteOptions = options;
    this.orchestrationRoutePickerActive = true;
    this.renderOrchestrationRoutePicker();
  }

  private showOrchestrationInput(mode: "message" | "handoff" | "task", target: DashboardOrchestrationTarget): void {
    this.orchestrationInputMode = mode;
    this.orchestrationInputTarget = target;
    this.orchestrationInputBuffer = "";
    this.orchestrationInputActive = true;
    this.renderOrchestrationInput();
  }

  private renderOrchestrationInput(): void {
    const target = this.orchestrationInputTarget;
    const mode = this.orchestrationInputMode;
    if (!target || !mode) return;
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
      `  Text: ${this.orchestrationInputBuffer}_`,
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
    process.stdout.write(output);
  }

  private renderOrchestrationRoutePicker(): void {
    const mode = this.orchestrationRouteMode;
    if (!mode) return;
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const modeLabel = mode === "message" ? "Send message" : mode === "handoff" ? "Send handoff" : "Assign task";
    const lines = [`${modeLabel}: choose target`, ""];
    for (let i = 0; i < Math.min(this.orchestrationRouteOptions.length, 9); i++) {
      lines.push(`  [${i + 1}] ${this.orchestrationRouteOptions[i]!.label}`);
    }
    if (this.orchestrationRouteOptions.length > 9) {
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
    process.stdout.write(output);
  }

  private formatRoutePreview(recipientIds: string[]): string {
    if (recipientIds.length === 0) return "";
    const preview = recipientIds.slice(0, 2).join(", ");
    const remainder = recipientIds.length > 2 ? `, +${recipientIds.length - 2}` : "";
    return ` [${recipientIds.length}: ${preview}${remainder}]`;
  }

  private async postToProjectService(path: string, body: unknown): Promise<any> {
    const endpoint = loadMetadataEndpoint();
    if (!endpoint) {
      throw new Error("no live project service endpoint");
    }
    const res = await fetch(`http://${endpoint.host}:${endpoint.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) {
      throw new Error(json?.error || `request failed: ${res.status}`);
    }
    return json;
  }

  private handleOrchestrationInputKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const event = events[0];
    const key = event.name || event.char;

    if (key === "escape") {
      this.orchestrationInputActive = false;
      this.orchestrationInputBuffer = "";
      this.orchestrationInputMode = null;
      this.orchestrationInputTarget = null;
      this.renderDashboard();
      return;
    }

    if (key === "enter" || key === "return") {
      const mode = this.orchestrationInputMode;
      const target = this.orchestrationInputTarget;
      const body = this.orchestrationInputBuffer.trim();
      this.orchestrationInputActive = false;
      this.orchestrationInputBuffer = "";
      this.orchestrationInputMode = null;
      this.orchestrationInputTarget = null;
      if (!mode || !target || !body) {
        this.renderDashboard();
        return;
      }
      void this.submitDashboardOrchestrationAction(mode, target, body);
      return;
    }

    if (key === "backspace" || key === "delete") {
      this.orchestrationInputBuffer = this.orchestrationInputBuffer.slice(0, -1);
      this.renderOrchestrationInput();
      return;
    }

    if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
      this.orchestrationInputBuffer += event.char;
      this.renderOrchestrationInput();
    }
  }

  private handleOrchestrationRoutePickerKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    if (key === "escape") {
      this.orchestrationRoutePickerActive = false;
      this.orchestrationRouteMode = null;
      this.orchestrationRouteOptions = [];
      this.renderDashboard();
      return;
    }

    if (key && /^[1-9]$/.test(key)) {
      const idx = parseInt(key, 10) - 1;
      const target = this.orchestrationRouteOptions[idx];
      const mode = this.orchestrationRouteMode;
      this.orchestrationRoutePickerActive = false;
      this.orchestrationRouteMode = null;
      this.orchestrationRouteOptions = [];
      if (!target || !mode) {
        this.renderDashboard();
        return;
      }
      this.showOrchestrationInput(mode, target);
    }
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
    const config = loadConfig();
    const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const lines = [
      this.pickerMode === "fork" && this.forkSourceSessionId
        ? `Fork from ${this.forkSourceSessionId}: select tool`
        : "Select tool:",
    ];
    for (let i = 0; i < tools.length; i++) {
      const available = isToolAvailable(tools[i][1].command);
      const label = available ? `  [${i + 1}] ${tools[i][0]}` : `  [${i + 1}] ${tools[i][0]} (not installed)`;
      lines.push(label);
    }
    lines.push("");
    lines.push("  [Esc] Cancel");

    const boxWidth = Math.max(...lines.map((l) => l.length)) + 4;
    const startRow = Math.floor((rows - lines.length - 2) / 2);
    const startCol = Math.floor((cols - boxWidth) / 2);

    let output = "\x1b7"; // save cursor
    for (let i = 0; i < lines.length + 2; i++) {
      const row = startRow + i;
      output += `\x1b[${row};${startCol}H`;
      if (i === 0 || i === lines.length + 1) {
        output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
      } else {
        const line = lines[i - 1];
        output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8"; // restore cursor
    process.stdout.write(output);
  }

  private runSelectedTool(toolKey: string, tool: ToolConfig): void {
    const wtPath = this.mode === "dashboard" ? this.dashboardState.focusedWorktreePath : undefined;

    if (this.pickerMode === "fork") {
      const sourceSessionId = this.forkSourceSessionId;
      this.pickerMode = "create";
      this.forkSourceSessionId = null;
      if (!sourceSessionId) {
        this.showDashboardError("Cannot fork session", ["Fork source was lost before tool selection. Try again."]);
        return;
      }
      this.startDashboardBusy("Forking agent", [
        `Source: ${sourceSessionId}`,
        `Tool: ${toolKey}`,
        "Seeding carried-over context",
      ]);
      void this.forkAgent({
        sourceSessionId,
        targetToolConfigKey: toolKey,
        targetWorktreePath: wtPath,
        open: true,
      })
        .catch((error) => this.showDashboardError("Cannot fork session", [String(error)]))
        .finally(() => this.clearDashboardBusy());
      return;
    }

    this.pickerMode = "create";
    this.forkSourceSessionId = null;
    this.createSession(tool.command, tool.args, tool.preambleFlag, toolKey, undefined, tool.sessionIdFlag, wtPath);
  }

  private showToolPicker(sourceSessionId?: string): void {
    const config = loadConfig();
    const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);
    this.pickerMode = sourceSessionId ? "fork" : "create";
    this.forkSourceSessionId = sourceSessionId ?? null;

    if (tools.length === 1) {
      const [key, tool] = tools[0];
      if (!isToolAvailable(tool.command)) {
        // Show all tools anyway so user sees what's supported
      } else {
        // Only one available tool — skip picker, spawn directly
        this.runSelectedTool(key, tool);
        return;
      }
    }

    this.pickerActive = true;
    this.renderToolPicker();
  }

  private handleToolPickerKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    this.pickerActive = false;

    if (key === "escape") {
      this.pickerMode = "create";
      this.forkSourceSessionId = null;
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }

    if (key >= "1" && key <= "9") {
      const config = loadConfig();
      const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);
      const idx = parseInt(key) - 1;
      if (idx < tools.length) {
        const [key, tool] = tools[idx];
        if (!isToolAvailable(tool.command)) {
          // Show brief error then redraw
          process.stdout.write(
            `\x1b7\x1b[${(process.stdout.rows ?? 24) - 2};1H\x1b[41;97m "${tool.command}" is not installed. Install it first. \x1b[0m\x1b8`,
          );
          setTimeout(() => {
            this.pickerActive = false;
            if (this.mode === "dashboard") this.renderDashboard();
            else this.focusSession(this.activeIndex);
          }, 2000);
          return;
        }
        this.runSelectedTool(key, tool);
        return;
      }
    }

    // Invalid key — redraw current view
    this.pickerMode = "create";
    this.forkSourceSessionId = null;
    this.renderDashboard();
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
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();
    const result = await this.forkSessionFromSource(
      opts.sourceSessionId,
      opts.targetToolConfigKey,
      opts.instruction,
      opts.targetWorktreePath,
    );
    if (!result) {
      throw new Error(`Unable to fork session ${opts.sourceSessionId}`);
    }
    if (opts.open !== false && result.target) {
      this.tmuxRuntimeManager.openTarget(result.target, { insideTmux: this.tmuxRuntimeManager.isInsideTmux() });
    }
    return {
      sessionId: result.sessionId,
      threadId: result.threadId,
    };
  }

  async spawnAgent(opts: {
    toolConfigKey: string;
    targetWorktreePath?: string;
    open?: boolean;
  }): Promise<{ sessionId: string }> {
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();

    const config = loadConfig();
    const toolCfg = config.tools[opts.toolConfigKey];
    if (!toolCfg) {
      throw new Error(`Unknown tool config: ${opts.toolConfigKey}`);
    }
    if (!toolCfg.enabled) {
      throw new Error(`Tool "${opts.toolConfigKey}" is disabled`);
    }
    if (!isToolAvailable(toolCfg.command)) {
      throw new Error(`Tool "${toolCfg.command}" is not installed or not on PATH`);
    }

    const targetWorktreePath = opts.targetWorktreePath === process.cwd() ? undefined : opts.targetWorktreePath;
    const transport = this.createSession(
      toolCfg.command,
      toolCfg.args,
      toolCfg.preambleFlag,
      opts.toolConfigKey,
      undefined,
      toolCfg.sessionIdFlag,
      targetWorktreePath,
    );

    const target = this.sessionTmuxTargets.get(transport.id);
    if (opts.open !== false && target) {
      this.tmuxRuntimeManager.openTarget(target, { insideTmux: this.tmuxRuntimeManager.isInsideTmux() });
    }

    return { sessionId: transport.id };
  }

  async renameAgent(sessionId: string, label?: string): Promise<{ sessionId: string; label?: string }> {
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();

    const runningSession = this.sessions.find((session) => session.id === sessionId);
    const offlineSession = this.offlineSessions.find((session) => session.id === sessionId);
    if (!runningSession && !offlineSession) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    await this.updateSessionLabel(sessionId, label);
    return { sessionId, label: this.getSessionLabel(sessionId) };
  }

  async stopAgent(sessionId: string): Promise<{ sessionId: string; status: "offline" }> {
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();

    const runningSession = this.sessions.find((session) => session.id === sessionId);
    if (!runningSession) {
      const offlineSession = this.offlineSessions.find((session) => session.id === sessionId);
      if (offlineSession) {
        return { sessionId, status: "offline" };
      }
      throw new Error(`Session "${sessionId}" not found`);
    }

    this.stopSessionToOffline(runningSession);
    await this.waitForSessionExit(runningSession);
    this.saveState();

    return { sessionId, status: "offline" };
  }

  async sendAgentToGraveyard(sessionId: string): Promise<{
    sessionId: string;
    status: "graveyard";
    previousStatus: "running" | "offline";
  }> {
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();

    let previousStatus: "running" | "offline";
    const runningSession = this.sessions.find((session) => session.id === sessionId);
    if (runningSession) {
      previousStatus = "running";
      this.stopSessionToOffline(runningSession);
      await this.waitForSessionExit(runningSession);
      this.saveState();
    } else {
      const offlineSession = this.offlineSessions.find((session) => session.id === sessionId);
      if (!offlineSession) {
        throw new Error(`Session "${sessionId}" not found`);
      }
      previousStatus = "offline";
    }

    this.graveyardSession(sessionId);
    return { sessionId, status: "graveyard", previousStatus };
  }

  async migrateAgentSession(
    sessionId: string,
    targetWorktreePath: string,
  ): Promise<{ sessionId: string; worktreePath?: string }> {
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();

    const runningSession = this.sessions.find((session) => session.id === sessionId);
    if (!runningSession) {
      const offlineSession = this.offlineSessions.find((session) => session.id === sessionId);
      if (offlineSession) {
        throw new Error(`Session "${sessionId}" is offline and cannot be migrated`);
      }
      throw new Error(`Session "${sessionId}" not found`);
    }

    await this.migrateAgent(sessionId, targetWorktreePath);
    await this.waitForSessionExit(runningSession);
    return { sessionId, worktreePath: this.getSessionWorktreePath(sessionId) };
  }

  private renderDashboard(): void {
    this.writeStatuslineFile();
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    let mainRepoPath: string | undefined;
    let mainCheckoutInfo = { name: "Main Checkout", branch: "" };
    try {
      mainRepoPath = findMainRepo();
    } catch {}

    const dashSessions = this.getDashboardSessions();

    // Build worktree groups from git
    let worktreeGroups: WorktreeGroup[] = [];
    try {
      const worktrees = listAllWorktrees();
      const mainWorktree =
        (mainRepoPath ? worktrees.find((wt) => wt.path === mainRepoPath) : worktrees[0]) ?? worktrees[0];
      if (mainWorktree) {
        mainCheckoutInfo = {
          name: "Main Checkout",
          branch: mainWorktree.branch,
        };
      }
      worktreeGroups = worktrees
        .filter((wt) => !wt.isBare && wt.path !== mainRepoPath)
        .map((wt) => {
          const wtSessions = dashSessions.filter((s) => s.worktreePath === wt.path);
          return {
            name: wt.name,
            branch: wt.branch,
            path: wt.path,
            status: (wtSessions.length > 0 ? "active" : "offline") as "active" | "offline",
            sessions: wtSessions,
          };
        });
    } catch {
      // Not in a git repo or no worktrees — skip grouping
    }

    // Build worktree navigation order: main repo first, then registered worktrees
    const hasWorktrees = worktreeGroups.length > 0;
    this.dashboardState.worktreeNavOrder = [undefined, ...worktreeGroups.map((wt) => wt.path)];
    // Ensure focusedWorktreePath is valid
    if (!this.dashboardState.worktreeNavOrder.includes(this.dashboardState.focusedWorktreePath)) {
      this.dashboardState.focusedWorktreePath = undefined;
    }

    // Determine selected session for cursor
    let selectedSession: string | undefined;

    // Determine selected session cursor
    if (hasWorktrees && this.dashboardState.level === "sessions" && this.dashboardState.worktreeSessions.length > 0) {
      selectedSession = this.dashboardState.worktreeSessions[this.dashboardState.sessionIndex]?.id;
    } else if (!hasWorktrees && dashSessions.length > 0) {
      // Flat mode — use activeIndex across all dash sessions
      selectedSession = dashSessions[this.activeIndex]?.id;
    }

    this.dashboard.update(
      dashSessions,
      worktreeGroups,
      this.dashboardState.focusedWorktreePath,
      hasWorktrees ? this.dashboardState.level : "sessions",
      selectedSession,
      "tmux",
      mainCheckoutInfo,
    );
    process.stdout.write(this.dashboard.render(cols, rows));
    if (this.dashboardBusyState) {
      this.renderDashboardBusyOverlay();
    } else if (this.dashboardErrorState) {
      this.renderDashboardErrorOverlay();
    }
  }

  private showWorktreeCreatePrompt(): void {
    this.worktreeInputActive = true;
    this.worktreeInputBuffer = "";
    this.renderWorktreeInput();
  }

  private renderWorktreeInput(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const lines = [
      "Create worktree:",
      "",
      `  Name: ${this.worktreeInputBuffer}_`,
      "",
      "  [Enter] create  [Esc] cancel",
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
        const line = lines[i - 1];
        output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8";
    process.stdout.write(output);
  }

  private handleWorktreeInputKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    if (key === "escape") {
      this.worktreeInputActive = false;
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }

    if (key === "enter" || key === "return") {
      this.worktreeInputActive = false;
      const name = this.worktreeInputBuffer.trim();
      if (name) {
        try {
          createWorktree(name);
          debug(`worktree created from UI: ${name}`, "worktree");
        } catch (err) {
          debug(`worktree create failed: ${err instanceof Error ? err.message : String(err)}`, "worktree");
        }
      }
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }

    if (key === "backspace" || key === "delete") {
      this.worktreeInputBuffer = this.worktreeInputBuffer.slice(0, -1);
      this.renderWorktreeInput();
      return;
    }

    // Append printable character
    if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
      this.worktreeInputBuffer += event.char;
      this.renderWorktreeInput();
    }
  }

  private renderLabelInput(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const lines = ["Name agent:", "", `  Name: ${this.labelInputBuffer}_`, "", "  [Enter] save  [Esc] cancel"];

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
        const line = lines[i - 1];
        output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8";
    process.stdout.write(output);
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
    this.worktreeListActive = true;
    this.renderWorktreeList();
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
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    let worktrees: Array<{ name: string; branch: string; path: string }> = [];
    try {
      worktrees = listAllWorktrees().filter((wt) => !wt.isBare);
    } catch {}

    const lines = ["Worktree Management:", ""];
    if (worktrees.length === 0) {
      lines.push("  No worktrees found.");
    } else {
      for (let i = 0; i < worktrees.length; i++) {
        const wt = worktrees[i];
        const isMain = i === 0 ? " \x1b[2m(main)\x1b[0m" : "";
        lines.push(`  [${i + 1}] ${wt.name} (${wt.branch})${isMain}`);
      }
    }
    lines.push("");
    lines.push("  [1-9] remove  [Esc] back");

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
        const line = lines[i - 1];
        output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8";
    process.stdout.write(output);
  }

  private renderWorktreeRemoveConfirm(): void {
    const confirm = this.worktreeRemoveConfirm;
    if (!confirm) return;

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const lines = [
      `Remove worktree "${confirm.name}"?`,
      "",
      `  Path: ${confirm.path}`,
      `  This runs: git worktree remove --force`,
      "",
      "  [y] yes  [n/Esc] cancel",
    ];

    const boxWidth = Math.max(...lines.map((l) => l.length)) + 4;
    const startRow = Math.floor((rows - lines.length - 2) / 2);
    const startCol = Math.floor((cols - boxWidth) / 2);

    let output = "\x1b7";
    for (let i = 0; i < lines.length + 2; i++) {
      const row = startRow + i;
      output += `\x1b[${row};${startCol}H`;
      if (i === 0 || i === lines.length + 1) {
        output += `\x1b[41;97m${"─".repeat(boxWidth)}\x1b[0m`;
      } else {
        output += `\x1b[41;97m  ${lines[i - 1].padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8";
    process.stdout.write(output);
  }

  private renderDashboardBusyOverlay(): void {
    const busy = this.dashboardBusyState;
    if (!busy) return;
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][busy.spinnerFrame % 10];
    const elapsed = ((Date.now() - busy.startedAt) / 1000).toFixed(1);
    const lines = [`${spinner} ${busy.title}`, "", ...busy.lines, "", `  Elapsed: ${elapsed}s`, "", "  Please wait"];

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
        output += `\x1b[44;97m  ${lines[i - 1].padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8";
    process.stdout.write(output);
  }

  private renderDashboardErrorOverlay(): void {
    const error = this.dashboardErrorState;
    if (!error) return;

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const lines = [error.title, "", ...error.lines.slice(0, 6).map((line) => `  ${line}`), "", "  [Esc/Enter] dismiss"];

    const boxWidth = Math.max(...lines.map((l) => l.length)) + 4;
    const startRow = Math.floor((rows - lines.length - 2) / 2);
    const startCol = Math.floor((cols - boxWidth) / 2);

    let output = "\x1b7";
    for (let i = 0; i < lines.length + 2; i++) {
      const row = startRow + i;
      output += `\x1b[${row};${startCol}H`;
      if (i === 0 || i === lines.length + 1) {
        output += `\x1b[41;97m${"─".repeat(boxWidth)}\x1b[0m`;
      } else {
        output += `\x1b[41;97m  ${lines[i - 1].padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8";
    process.stdout.write(output);
  }

  private startDashboardBusy(title: string, lines: string[]): void {
    this.dashboardErrorState = null;
    this.dashboardBusyState = {
      title,
      lines,
      startedAt: Date.now(),
      spinnerFrame: 0,
    };
    if (this.dashboardBusySpinner) {
      clearInterval(this.dashboardBusySpinner);
    }
    this.dashboardBusySpinner = setInterval(() => {
      if (!this.dashboardBusyState) return;
      this.dashboardBusyState.spinnerFrame = (this.dashboardBusyState.spinnerFrame + 1) % 10;
      if (this.mode === "dashboard") this.renderDashboard();
    }, 120);
    this.footerFlash = null;
    this.footerFlashTicks = 0;
    this.renderDashboard();
  }

  private updateDashboardBusy(lines: string[]): void {
    if (!this.dashboardBusyState) return;
    this.dashboardBusyState.lines = lines;
    if (this.mode === "dashboard") this.renderDashboard();
  }

  private clearDashboardBusy(): void {
    if (this.dashboardBusySpinner) {
      clearInterval(this.dashboardBusySpinner);
      this.dashboardBusySpinner = null;
    }
    this.dashboardBusyState = null;
  }

  private showDashboardError(title: string, lines: string[]): void {
    this.clearDashboardBusy();
    this.dashboardErrorState = { title, lines };
    this.renderDashboard();
  }

  private dismissDashboardError(): void {
    this.dashboardErrorState = null;
    this.renderDashboard();
  }

  private beginWorktreeRemoval(path: string, name: string, oldIdx: number): void {
    if (this.worktreeRemovalJob) return;

    let child;
    try {
      child = spawn("git", ["worktree", "remove", path, "--force"], {
        cwd: findMainRepo(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showDashboardError(`Failed to remove "${name}"`, [`Path: ${path}`, `Error: ${message}`]);
      return;
    }

    this.worktreeRemovalJob = {
      path,
      name,
      startedAt: Date.now(),
      oldIdx,
      stderr: "",
    };
    this.startDashboardBusy(`Removing worktree "${name}"`, [
      `  Path: ${path}`,
      "  Cleaning up checkout and metadata...",
    ]);

    child.stderr.on("data", (chunk: Buffer) => {
      if (!this.worktreeRemovalJob) return;
      this.worktreeRemovalJob.stderr += chunk.toString();
      const detail = this.worktreeRemovalJob.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      this.updateDashboardBusy([
        `  Path: ${path}`,
        detail ? `  Git: ${detail.slice(0, 80)}` : "  Cleaning up checkout and metadata...",
      ]);
    });

    child.on("close", (code: number | null) => {
      this.finishWorktreeRemoval(code ?? 1);
    });

    child.on("error", (err: Error) => {
      if (!this.worktreeRemovalJob) return;
      this.worktreeRemovalJob.stderr += `\n${err.message}`;
      this.finishWorktreeRemoval(1);
    });
  }

  private finishWorktreeRemoval(code: number): void {
    const job = this.worktreeRemovalJob;
    if (!job) return;

    this.worktreeRemovalJob = null;
    const details = job.stderr
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (code === 0) {
      this.clearDashboardBusy();
      this.footerFlash = `Removed: ${job.name}`;
      this.footerFlashTicks = 3;
      debug(`removed worktree: ${job.name}`, "worktree");

      const newWorktrees = listAllWorktrees().filter((wt) => !wt.isBare);
      this.dashboardState.worktreeNavOrder = [undefined, ...newWorktrees.map((wt) => wt.path)];
      if (job.oldIdx >= 0 && job.oldIdx < this.dashboardState.worktreeNavOrder.length) {
        this.dashboardState.focusedWorktreePath = this.dashboardState.worktreeNavOrder[job.oldIdx];
      } else if (this.dashboardState.worktreeNavOrder.length > 1) {
        this.dashboardState.focusedWorktreePath =
          this.dashboardState.worktreeNavOrder[this.dashboardState.worktreeNavOrder.length - 1];
      } else {
        this.dashboardState.focusedWorktreePath = undefined;
      }
    } else {
      const message = details[0] ?? `git worktree remove exited with code ${code}`;
      this.footerFlash = `Failed: ${message}`;
      this.footerFlashTicks = 5;
      this.showDashboardError(`Failed to remove "${job.name}"`, [`Path: ${job.path}`, `Error: ${message}`, ...details]);
      return;
    }

    this.renderDashboard();
  }

  private handleWorktreeRemoveConfirmKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const key = events[0].name || events[0].char;

    if (key === "y") {
      const confirm = this.worktreeRemoveConfirm;
      if (confirm) {
        this.worktreeRemoveConfirm = null;
        const oldIdx = this.dashboardState.worktreeNavOrder.indexOf(confirm.path);
        this.beginWorktreeRemoval(confirm.path, confirm.name, oldIdx);
        return;
      }
    }

    // Any other key cancels
    this.worktreeRemoveConfirm = null;
    this.renderDashboard();
  }

  private handleWorktreeListKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    if (key === "escape") {
      this.worktreeListActive = false;
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }

    if (key >= "1" && key <= "9") {
      try {
        const worktrees = listAllWorktrees();
        const idx = parseInt(key) - 1;
        if (idx < worktrees.length && idx > 0) {
          // skip main worktree (index 0)
          execSync(`git worktree remove "${worktrees[idx].path}" --force`, {
            cwd: findMainRepo(),
            encoding: "utf-8",
            stdio: "pipe",
          });
          debug(`removed worktree from UI: ${worktrees[idx].name}`, "worktree");
        }
      } catch (err) {
        debug(`worktree remove failed: ${err instanceof Error ? err.message : String(err)}`, "worktree");
      }
      // Re-render the list
      this.renderWorktreeList();
      return;
    }
  }

  private showGraveyard(): void {
    this.clearDashboardSubscreens();
    const graveyardPath = getGraveyardPath();
    try {
      this.graveyardEntries = JSON.parse(readFileSync(graveyardPath, "utf-8")) as SessionState[];
    } catch {
      this.graveyardEntries = [];
    }
    if (this.graveyardIndex >= this.graveyardEntries.length) {
      this.graveyardIndex = Math.max(0, this.graveyardEntries.length - 1);
    }
    this.setDashboardScreen("graveyard");
    this.writeStatuslineFile();
    this.renderGraveyard();
  }

  private renderGraveyard(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const header: string[] = [];
    header.push("");
    header.push(this.centerInWidth("\x1b[1maimux\x1b[0m — graveyard", cols));
    header.push(this.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
    header.push("");
    const footer = this.centerInWidth(
      "[↑↓] select  [Tab] details  [d/a/y/t/p/g] screens  [1-9/Enter] resurrect  [Esc] dashboard  [q] quit",
      cols,
    );
    const viewportHeight = rows - header.length - 2;
    const twoPane = cols >= 110 && this.dashboardState.detailsSidebarVisible;
    const listLines: string[] = [];
    if (this.graveyardEntries.length === 0) {
      listLines.push("  Graveyard");
      listLines.push("    (empty)");
    } else {
      listLines.push("  Graveyard");
      for (let i = 0; i < this.graveyardEntries.length; i++) {
        const s = this.graveyardEntries[i];
        const bsid = s.backendSessionId ? ` (${s.backendSessionId.slice(0, 8)}…)` : "";
        const identity = s.label ? ` — ${s.label}` : "";
        const headline = s.headline ? ` · ${s.headline}` : "";
        const marker = i === this.graveyardIndex ? "\x1b[33m▸\x1b[0m " : "  ";
        listLines.push(`    ${marker}[${i + 1}] ${s.command}:${s.id}${bsid}${identity}${headline}`);
      }
    }
    const focusLine = this.graveyardEntries.length === 0 ? 1 : this.graveyardIndex + 1;
    const body = this.composeSplitScreen(
      listLines,
      this.renderGraveyardDetails(Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
      cols,
      viewportHeight,
      focusLine,
      twoPane,
    );
    process.stdout.write(
      "\x1b[2J\x1b[H" +
        [...header, ...body, this.centerInWidth("─".repeat(Math.min(cols - 4, 52)), cols), footer].join("\r\n"),
    );
  }

  private handleGraveyardKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    if (key === "tab") {
      this.dashboardState.toggleDetailsSidebar();
      this.renderGraveyard();
      return;
    }

    if (key === "q") {
      this.tmuxRuntimeManager.leaveManagedSession({
        insideTmux: this.tmuxRuntimeManager.isInsideTmux(),
        sessionName: this.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
      });
      this.cleanup();
      process.exit(0);
      return;
    }

    if (key === "escape" || key === "d") {
      this.setDashboardScreen("dashboard");
      this.renderDashboard();
      return;
    }
    if (this.handleDashboardSubscreenNavigationKey(key, "graveyard")) return;

    if (key === "?") {
      this.showHelp();
      return;
    }

    if (key === "down" || key === "j" || key === "n") {
      if (this.graveyardEntries.length > 1) {
        this.graveyardIndex = (this.graveyardIndex + 1) % this.graveyardEntries.length;
        this.renderGraveyard();
      }
      return;
    }

    if (key === "up" || key === "k") {
      if (this.graveyardEntries.length > 1) {
        this.graveyardIndex = (this.graveyardIndex - 1 + this.graveyardEntries.length) % this.graveyardEntries.length;
        this.renderGraveyard();
      }
      return;
    }

    if (key >= "1" && key <= "9") {
      this.resurrectGraveyardEntry(parseInt(key) - 1);
      return;
    }

    if (key === "enter" || key === "return") {
      this.resurrectGraveyardEntry(this.graveyardIndex);
      return;
    }
  }

  private resurrectGraveyardEntry(idx: number): void {
    if (idx < 0 || idx >= this.graveyardEntries.length) return;
    const entry = this.graveyardEntries[idx];
    if (!entry) return;
    void this.resurrectGraveyardSession(entry.id)
      .then(() => {
        this.graveyardEntries = this.listGraveyardEntries();
        if (this.graveyardEntries.length === 0) {
          this.setDashboardScreen("dashboard");
          if (this.mode === "dashboard") {
            this.renderDashboard();
          } else {
            this.focusSession(this.activeIndex);
          }
          return;
        }

        if (this.graveyardIndex >= this.graveyardEntries.length) {
          this.graveyardIndex = this.graveyardEntries.length - 1;
        }
        this.renderGraveyard();
      })
      .catch((error) => {
        debug(`failed to resurrect ${entry.id}: ${error instanceof Error ? error.message : String(error)}`, "session");
      });
  }

  private showPlans(): void {
    this.clearDashboardSubscreens();
    this.loadPlanEntries();
    this.setDashboardScreen("plans");
    if (this.planIndex >= this.planEntries.length) {
      this.planIndex = Math.max(0, this.planEntries.length - 1);
    }
    this.writeStatuslineFile();
    this.renderPlans();
  }

  private loadPlanEntries(): void {
    const plansDir = getPlansDir();
    const entries: PlanEntry[] = [];
    try {
      mkdirSync(plansDir, { recursive: true });
      const files = readdirSync(plansDir)
        .filter((file) => file.endsWith(".md"))
        .sort();
      for (const file of files) {
        const path = join(plansDir, file);
        const content = readFileSync(path, "utf-8");
        const sessionId = file.replace(/\.md$/, "");
        const frontmatter = this.parsePlanFrontmatter(content);
        entries.push({
          sessionId,
          tool: frontmatter.tool,
          label: this.getSessionLabel(sessionId),
          worktree: frontmatter.worktree,
          updatedAt: frontmatter.updatedAt,
          path,
          content,
        });
      }
    } catch {}
    entries.sort((a, b) => {
      const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bTime - aTime || a.sessionId.localeCompare(b.sessionId);
    });
    this.planEntries = entries;
  }

  private parsePlanFrontmatter(content: string): Record<string, string> {
    const lines = content.split(/\r?\n/);
    if (lines[0] !== "---") return {};
    const data: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === "---") break;
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return data;
  }

  private renderPlans(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const header: string[] = [];
    header.push("");
    header.push(this.centerInWidth("\x1b[1maimux\x1b[0m — plans", cols));
    header.push(this.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
    header.push("");
    const footer = this.centerInWidth(
      "[↑↓] select  [Tab] details  [d/a/y/t/p/g] screens  [e/Enter] edit  [r] refresh  [Esc] dashboard  [q] quit",
      cols,
    );
    const viewportHeight = rows - header.length - 2;
    const twoPane = cols >= 110 && this.dashboardState.detailsSidebarVisible;
    const listLines: string[] = [];

    if (this.planEntries.length === 0) {
      listLines.push("  No plan files found in .aimux/plans/");
    } else {
      listLines.push("  Plans");
      for (let i = 0; i < this.planEntries.length; i++) {
        const plan = this.planEntries[i];
        const selected = i === this.planIndex;
        const marker = selected ? "\x1b[33m▸\x1b[0m " : "  ";
        const identity = plan.label ?? plan.tool ?? "unknown";
        const worktree = plan.worktree ?? "main";
        const updated = plan.updatedAt ? ` · ${plan.updatedAt.replace("T", " ").slice(0, 16)}` : "";
        listLines.push(`${marker}[${i + 1}] ${identity} \x1b[2m(${plan.sessionId})\x1b[0m · ${worktree}${updated}`);
      }
    }
    const focusLine = this.planEntries.length === 0 ? 0 : this.planIndex + 1;
    const body = this.composeSplitScreen(
      listLines,
      this.renderPlanDetails(Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
      cols,
      viewportHeight,
      focusLine,
      twoPane,
    );
    process.stdout.write(
      "\x1b[2J\x1b[H" +
        [...header, ...body, this.centerInWidth("─".repeat(Math.min(cols - 4, 56)), cols), footer].join("\r\n"),
    );
  }

  private buildPlanPreview(content: string, width: number, maxLines: number): string[] {
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    const rawLines = body.length > 0 ? body.split(/\r?\n/) : ["(empty)"];
    const preview: string[] = [];
    for (const line of rawLines) {
      if (preview.length >= maxLines) break;
      const normalized = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
      preview.push(normalized);
    }
    return preview;
  }

  private renderPlanDetails(width: number, height: number): string[] {
    const selectedPlan = this.planEntries[this.planIndex];
    if (!selectedPlan) return new Array(height).fill("");
    const lines: string[] = [];
    lines.push("\x1b[1mDetails\x1b[0m");
    lines.push(
      ...this.wrapKeyValue(
        "Agent",
        `${selectedPlan.label ?? selectedPlan.tool ?? "unknown"} (${selectedPlan.sessionId})`,
        width,
      ),
    );
    lines.push(...this.wrapKeyValue("Tool", selectedPlan.tool ?? "unknown", width));
    lines.push(...this.wrapKeyValue("Worktree", selectedPlan.worktree ?? "main", width));
    if (selectedPlan.updatedAt) lines.push(...this.wrapKeyValue("Updated", selectedPlan.updatedAt, width));
    lines.push(...this.wrapKeyValue("File", `.aimux/plans/${selectedPlan.sessionId}.md`, width));
    lines.push("");
    lines.push("\x1b[1mPreview\x1b[0m");
    for (const previewLine of this.buildPlanPreview(selectedPlan.content, width, Math.max(4, height - lines.length))) {
      lines.push(previewLine);
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderGraveyardDetails(width: number, height: number): string[] {
    const selected = this.graveyardEntries[this.graveyardIndex];
    if (!selected) return new Array(height).fill("");
    const lines: string[] = [];
    lines.push("\x1b[1mDetails\x1b[0m");
    lines.push(...this.wrapKeyValue("Agent", `${selected.label ?? selected.command} (${selected.id})`, width));
    lines.push(...this.wrapKeyValue("Tool", selected.command, width));
    lines.push(...this.wrapKeyValue("Status", "offline", width));
    if (selected.worktreePath) lines.push(...this.wrapKeyValue("Worktree", selected.worktreePath, width));
    if (selected.backendSessionId) lines.push(...this.wrapKeyValue("Backend", selected.backendSessionId, width));
    if (selected.headline) lines.push(...this.wrapKeyValue("Headline", selected.headline, width));
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private composeSplitScreen(
    leftLines: string[],
    rightLines: string[],
    cols: number,
    viewportHeight: number,
    focusLine: number,
    twoPane: boolean,
  ): string[] {
    const content = [...leftLines];
    let scrollOffset = 0;
    const maxScroll = Math.max(0, content.length - viewportHeight);
    if (focusLine >= 0) {
      if (focusLine < scrollOffset + 1) {
        scrollOffset = Math.max(0, focusLine - 1);
      } else if (focusLine >= scrollOffset + viewportHeight - 1) {
        scrollOffset = Math.min(maxScroll, focusLine - viewportHeight + 2);
      }
    }
    const visibleLeft = content.slice(scrollOffset, scrollOffset + viewportHeight);
    const canScrollUp = scrollOffset > 0;
    const canScrollDown = scrollOffset < maxScroll;
    if (canScrollUp && visibleLeft.length > 0) visibleLeft[0] = this.centerInWidth("\x1b[2m▲ more ▲\x1b[0m", cols);
    if (canScrollDown && visibleLeft.length > 0) {
      visibleLeft[visibleLeft.length - 1] = this.centerInWidth("\x1b[2m▼ more ▼\x1b[0m", cols);
    }
    while (visibleLeft.length < viewportHeight) visibleLeft.push("");
    if (!twoPane) return visibleLeft;
    return this.composeTwoPaneLines(visibleLeft, rightLines, cols);
  }

  private composeTwoPaneLines(left: string[], right: string[], cols: number): string[] {
    const leftWidth = Math.max(40, Math.floor(cols * 0.56));
    const rightWidth = Math.max(24, cols - leftWidth - 4);
    const height = Math.max(left.length, right.length);
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      const leftLine = this.truncateAnsi(left[i] ?? "", leftWidth);
      const rightLine = this.truncateAnsi(right[i] ?? "", rightWidth);
      const leftPad = Math.max(0, leftWidth - this.stripAnsi(leftLine).length);
      out.push(`${leftLine}${" ".repeat(leftPad)} │ ${rightLine}`);
    }
    return out;
  }

  private wrapKeyValue(key: string, value: string, width: number): string[] {
    const prefix = `${key}: `;
    const wrapped = this.wrapText(value, Math.max(8, width - prefix.length));
    return wrapped.map((line, idx) => (idx === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`));
  }

  private wrapText(text: string, width: number): string[] {
    const plain = text.trim();
    if (!plain) return [""];
    if (width <= 8) return [this.truncatePlain(plain, width)];
    const words = plain.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= width) {
        current = next;
        continue;
      }
      if (current) lines.push(current);
      current = word.length > width ? this.truncatePlain(word, width) : word;
    }
    if (current) lines.push(current);
    return lines;
  }

  private truncatePlain(text: string, max: number): string {
    if (text.length <= max) return text;
    if (max <= 1) return text.slice(0, max);
    return `${text.slice(0, max - 1)}…`;
  }

  private truncateAnsi(text: string, max: number): string {
    if (max <= 0) return "";
    const plainLength = this.stripAnsi(text).length;
    const needsEllipsis = plainLength > max;
    const limit = needsEllipsis && max > 1 ? max - 1 : max;
    let visible = 0;
    let out = "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\x1b") {
        const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
        if (match) {
          out += match[0];
          i += match[0].length - 1;
          continue;
        }
      }
      if (visible >= limit) break;
      out += text[i];
      visible += 1;
    }
    if (needsEllipsis) out += "…";
    if (out.includes("\x1b[")) out += "\x1b[0m";
    return out;
  }

  private handlePlansKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const key = events[0].name || events[0].char;

    if (key === "tab") {
      this.dashboardState.toggleDetailsSidebar();
      this.renderPlans();
      return;
    }

    if (key === "q") {
      this.tmuxRuntimeManager.leaveManagedSession({
        insideTmux: this.tmuxRuntimeManager.isInsideTmux(),
        sessionName: this.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
      });
      this.cleanup();
      process.exit(0);
      return;
    }

    if (key === "escape" || key === "d") {
      this.setDashboardScreen("dashboard");
      this.renderDashboard();
      return;
    }
    if (this.handleDashboardSubscreenNavigationKey(key, "plans")) return;

    if (key === "?") {
      this.showHelp();
      return;
    }

    if (key === "r") {
      this.loadPlanEntries();
      if (this.planIndex >= this.planEntries.length) {
        this.planIndex = Math.max(0, this.planEntries.length - 1);
      }
      this.renderPlans();
      return;
    }

    if (key === "down" || key === "j" || key === "n") {
      if (this.planEntries.length > 1) {
        this.planIndex = (this.planIndex + 1) % this.planEntries.length;
        this.renderPlans();
      }
      return;
    }

    if (key === "up" || key === "k") {
      if (this.planEntries.length > 1) {
        this.planIndex = (this.planIndex - 1 + this.planEntries.length) % this.planEntries.length;
        this.renderPlans();
      }
      return;
    }

    if (key >= "1" && key <= "9") {
      const idx = parseInt(key, 10) - 1;
      if (idx < this.planEntries.length) {
        this.planIndex = idx;
        this.renderPlans();
      }
      return;
    }

    if (key === "e" || key === "enter" || key === "return") {
      const selectedPlan = this.planEntries[this.planIndex];
      if (!selectedPlan) return;
      this.openPlanInEditor(selectedPlan.path);
    }
  }

  private openPlanInEditor(path: string): void {
    const editor = process.env.VISUAL || process.env.EDITOR || "vim";
    const shell = process.env.SHELL || "/bin/zsh";
    const shellEscape = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

    this.terminalHost.exitRawMode();
    this.terminalHost.exitAlternateScreen();

    const result = spawnSync(shell, ["-lc", `${editor} ${shellEscape(path)}`], { stdio: "inherit" });

    this.terminalHost.enterRawMode();
    this.terminalHost.enterAlternateScreen(true);

    if (result.error) {
      this.dashboardErrorState = {
        title: `Failed to open editor "${editor}"`,
        lines: [result.error.message],
      };
    }

    this.loadPlanEntries();
    this.planIndex = Math.min(this.planIndex, Math.max(0, this.planEntries.length - 1));
    this.renderPlans();
    if (this.dashboardErrorState) {
      this.renderDashboardErrorOverlay();
    }
  }

  // --- Quick Switcher (^A s) ---

  /** Get sessions in MRU order (most recently used first), only running/alive sessions */
  private getSwitcherList(): ManagedSession[] {
    const alive = this.getScopedSessionEntries()
      .map(({ session }) => session)
      .filter((s) => !s.exited);
    // Build MRU-ordered list: known MRU order first, then any remaining
    const ordered: ManagedSession[] = [];
    for (const id of this.sessionMRU) {
      const s = alive.find((a) => a.id === id);
      if (s) ordered.push(s);
    }
    // Append any sessions not yet in MRU
    for (const s of alive) {
      if (!ordered.includes(s)) ordered.push(s);
    }
    return ordered;
  }

  private showSwitcher(): void {
    const list = this.getSwitcherList();
    if (list.length < 2) return;

    this.switcherActive = true;
    this.switcherIndex = 1; // Start on second item (most recent non-current)
    this.renderSwitcher();
    this.resetSwitcherTimeout();
  }

  private resetSwitcherTimeout(): void {
    if (this.switcherTimeout) clearTimeout(this.switcherTimeout);
    this.switcherTimeout = setTimeout(() => {
      this.confirmSwitcher();
    }, 1000);
  }

  private confirmSwitcher(): void {
    if (this.switcherTimeout) {
      clearTimeout(this.switcherTimeout);
      this.switcherTimeout = null;
    }
    this.switcherActive = false;

    const list = this.getSwitcherList();
    const target = list[this.switcherIndex];
    if (target) {
      const idx = this.sessions.indexOf(target);
      if (idx >= 0) this.focusSession(idx);
    }
  }

  private dismissSwitcher(): void {
    if (this.switcherTimeout) {
      clearTimeout(this.switcherTimeout);
      this.switcherTimeout = null;
    }
    this.switcherActive = false;
    this.renderDashboard();
  }

  private redrawCurrentView(): void {
    this.renderDashboard();
  }

  private showHelp(): void {
    this.clearDashboardSubscreens();
    this.setDashboardScreen("help");
    this.writeStatuslineFile();
    this.renderHelp();
  }

  private dismissHelp(): void {
    this.setDashboardScreen("dashboard");
    this.redrawCurrentView();
  }

  private renderHelp(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const allLines = [
      "Help",
      "",
      "Tmux mode",
      "  Dashboard lives in a managed tmux dashboard window",
      "  Each agent runs in its own tmux window",
      "  Use normal tmux window navigation inside agents",
      "  Run aimux with no args to return to the dashboard window",
      "",
      "Dashboard mode",
      "  Ctrl+A ?  show help",
      "  Ctrl+A c  new agent",
      "  Ctrl+A x  stop agent",
      "  Ctrl+A w  create worktree",
      "  Ctrl+A W  worktree list",
      "  Ctrl+A v  request review",
      "  Ctrl+A 1-9  focus numbered agent",
      "  Ctrl+A d  return to dashboard window",
      "  arrows / j k n p  navigate",
      "  Enter  open, resume, or takeover",
      "  a  activity",
      "  y  workflow",
      "  p  plans",
      "  r  name agent",
      "  m  migrate agent",
      "  g  graveyard",
      "  q  quit",
      "",
      "Esc, Enter, or ? to close",
    ];

    const visibleRows = rows;
    const maxContentRows = Math.max(6, visibleRows - 2);
    let lines = [...allLines];
    if (lines.length > maxContentRows) {
      const closeLine = lines[lines.length - 1];
      const available = Math.max(4, maxContentRows - 2);
      lines = [...lines.slice(0, available), "...", closeLine];
    }

    const ellipsizeEnd = (s: string, max: number) => {
      if (max <= 0) return "";
      if (s.length <= max) return s;
      if (max <= 1) return "…";
      return `${s.slice(0, max - 1)}…`;
    };

    const contentWidth = Math.max(36, Math.min(cols - 6, Math.max(...lines.map((line) => line.length))));
    const boxWidth = contentWidth + 4;
    const boxHeight = lines.length + 2;
    const startRow = Math.max(1, Math.floor((visibleRows - boxHeight) / 2));
    const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));
    let output = "\x1b7";
    for (let i = 0; i < boxHeight; i++) {
      const row = startRow + i;
      output += `\x1b[${row};${startCol}H`;
      if (i === 0 || i === boxHeight - 1) {
        output += `\x1b[44;97m${" ".repeat(boxWidth)}\x1b[0m`;
      } else {
        const line = ellipsizeEnd(lines[i - 1] ?? "", contentWidth);
        output += `\x1b[44;97m  ${line.padEnd(contentWidth)}  \x1b[0m`;
      }
    }
    output += "\x1b8";
    process.stdout.write(output);
  }

  private handleHelpKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;
    const event = events[0];
    const key = event.name || event.char;

    if (key === "q") {
      this.tmuxRuntimeManager.leaveManagedSession({
        insideTmux: this.tmuxRuntimeManager.isInsideTmux(),
        sessionName: this.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
      });
      this.cleanup();
      process.exit(0);
      return;
    }
    if (key === "escape" || key === "enter" || key === "return" || key === "d") {
      this.dismissHelp();
      return;
    }
    if (key === "p") {
      this.dismissHelp();
      this.showPlans();
      return;
    }
    if (key === "a") {
      this.dismissHelp();
      this.showActivityDashboard();
      return;
    }
    if (key === "y") {
      this.dismissHelp();
      this.showWorkflow();
      return;
    }
    if (key === "g") {
      this.dismissHelp();
      this.showGraveyard();
      return;
    }
    if (key === "?") {
      this.dismissHelp();
    }
  }

  private renderSwitcher(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const list = this.getSwitcherList();

    const ellipsizeEnd = (s: string, max: number) => {
      if (max <= 0) return "";
      if (s.length <= max) return s;
      if (max <= 1) return "…";
      return `${s.slice(0, max - 1)}…`;
    };

    const lines: string[] = ["Switch Agent:"];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const wtPath = this.sessionWorktreePaths.get(s.id);
      const wtLabel = wtPath ? ` (${wtPath.split("/").pop()})` : "";
      const current = s.id === this.sessions[this.activeIndex]?.id ? " (current)" : "";
      const pointer = i === this.switcherIndex ? "▸ " : "  ";
      lines.push(`${pointer}${s.command}:${s.id}${wtLabel}${current}`);
    }
    lines.push("");
    lines.push("  [s] cycle  Enter confirm  [x] stop  Esc cancel");

    const contentWidth = Math.max(20, Math.min(cols - 6, Math.max(...lines.map((l) => l.length))));
    const boxWidth = contentWidth + 4;
    const startRow = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
    const startCol = Math.max(1, Math.floor((cols - boxWidth) / 2));

    let output = "\x1b7"; // save cursor
    for (let i = 0; i < lines.length + 2; i++) {
      const row = startRow + i;
      output += `\x1b[${row};${startCol}H`;
      if (i === 0 || i === lines.length + 1) {
        output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
      } else {
        const line = ellipsizeEnd(lines[i - 1], contentWidth);
        output += `\x1b[44;97m  ${line.padEnd(contentWidth)}  \x1b[0m`;
      }
    }
    output += "\x1b8"; // restore cursor
    process.stdout.write(output);
  }

  private handleSwitcherKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    if (key === "s") {
      // Cycle to next item
      const list = this.getSwitcherList();
      this.switcherIndex = (this.switcherIndex + 1) % list.length;
      this.renderSwitcher();
      this.resetSwitcherTimeout();
      return;
    }

    if (key === "return" || key === "enter") {
      this.confirmSwitcher();
      return;
    }

    if (key === "escape") {
      this.dismissSwitcher();
      return;
    }

    if (key === "x") {
      const list = this.getSwitcherList();
      const target = list[this.switcherIndex];
      if (!target) return;

      // Stop the highlighted session (moves to offline)
      this.dismissSwitcher();
      void this.stopSessionToOfflineWithFeedback(target);

      return;
    }

    // Any other key dismisses
    this.dismissSwitcher();
  }

  private showMigratePicker(): void {
    // Collect available worktrees to migrate to
    try {
      const worktrees = listAllWorktrees();
      const mainRepo = findMainRepo();
      this.migratePickerWorktrees = [
        { name: "(main)", path: mainRepo },
        ...worktrees.filter((wt) => wt.path !== mainRepo).map((wt) => ({ name: wt.name, path: wt.path })),
      ];
    } catch {
      this.migratePickerWorktrees = [];
    }

    if (this.migratePickerWorktrees.length <= 1) {
      // No worktrees to migrate to
      return;
    }

    this.migratePickerActive = true;
    this.renderMigratePicker();
  }

  private renderMigratePicker(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const session = this.sessions[this.activeIndex];
    if (!session) return;

    const currentWt = this.sessionWorktreePaths.get(session.id);
    const lines = [`Migrate "${session.id}" to:`, ""];
    for (let i = 0; i < this.migratePickerWorktrees.length; i++) {
      const wt = this.migratePickerWorktrees[i];
      const isCurrent = wt.path === currentWt || (!currentWt && wt.name === "(main)");
      const marker = isCurrent ? " (current)" : "";
      lines.push(`  [${i + 1}] ${wt.name}${marker}`);
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
        const line = lines[i - 1];
        output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8";
    process.stdout.write(output);
  }

  private waitForSessionExit(session: ManagedSession, timeoutMs = 15_000): Promise<void> {
    if (session.exited) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${session.id} to exit`)), timeoutMs);
      session.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async runDashboardOperation<T>(
    title: string,
    lines: string[],
    work: () => Promise<T> | T,
    errorTitle = title,
  ): Promise<T | undefined> {
    this.startDashboardBusy(title, lines);
    const minVisibleMs = 250;
    const startedAt = Date.now();
    try {
      const result = await work();
      const remaining = minVisibleMs - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      this.clearDashboardBusy();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showDashboardError(errorTitle, [message]);
      return undefined;
    }
  }

  private async stopSessionToOfflineWithFeedback(session: ManagedSession): Promise<void> {
    const label = this.getSessionLabel(session.id) ?? session.command;
    await this.runDashboardOperation(
      `Stopping "${label}"`,
      [`  Session: ${session.id}`, `  Tool: ${session.command}`],
      async () => {
        this.stopSessionToOffline(session);
        await this.waitForSessionExit(session);
        this.renderDashboard();
      },
      `Failed to stop "${label}"`,
    );
  }

  private clearDashboardSubscreens(): void {
    this.dashboardState.resetSubscreen();
  }

  private renderSessionDetails(session: DashboardSession | undefined, width: number, height: number): string[] {
    if (!session) return new Array(height).fill("");
    const lines: string[] = [];
    lines.push("\x1b[1mDetails\x1b[0m");
    lines.push(...this.wrapKeyValue("Agent", `${session.label ?? session.command} (${session.id})`, width));
    lines.push(...this.wrapKeyValue("Tool", session.command, width));
    if (session.worktreeName || session.worktreeBranch) {
      lines.push(
        ...this.wrapKeyValue(
          "Worktree",
          `${session.worktreeName ?? "main"}${session.worktreeBranch ? ` · ${session.worktreeBranch}` : ""}`,
          width,
        ),
      );
    }
    if (session.cwd) {
      lines.push(...this.wrapKeyValue("CWD", session.cwd, width));
    }
    if (session.prNumber || session.prTitle || session.prUrl) {
      const prHeader = [`PR${session.prNumber ? ` #${session.prNumber}` : ""}`];
      if (session.prTitle) prHeader.push(session.prTitle);
      lines.push(...this.wrapKeyValue("PR", prHeader.join(": "), width));
      if (session.prUrl) lines.push(...this.wrapKeyValue("URL", session.prUrl, width));
    }
    if (session.repoOwner || session.repoName) {
      lines.push(...this.wrapKeyValue("Repo", `${session.repoOwner ?? "?"}/${session.repoName ?? "?"}`, width));
    }
    if (session.repoRemote) {
      lines.push(...this.wrapKeyValue("Remote", session.repoRemote, width));
    }
    if (session.activity) {
      lines.push(...this.wrapKeyValue("Activity", session.activity, width));
    }
    if (session.attention && session.attention !== "normal") {
      lines.push(...this.wrapKeyValue("Attention", session.attention, width));
    }
    if ((session.unseenCount ?? 0) > 0) {
      lines.push(...this.wrapKeyValue("Unseen", String(session.unseenCount), width));
    }
    if (session.lastEvent?.message) {
      lines.push(...this.wrapKeyValue("Last", session.lastEvent.message, width));
    }
    if (session.threadName || session.threadId) {
      lines.push(...this.wrapKeyValue("Thread", session.threadName ?? session.threadId ?? "", width));
    }
    if (
      (session.threadUnreadCount ?? 0) > 0 ||
      (session.threadWaitingOnMeCount ?? 0) > 0 ||
      (session.threadWaitingOnThemCount ?? 0) > 0 ||
      (session.threadPendingCount ?? 0) > 0
    ) {
      lines.push(
        ...this.wrapKeyValue(
          "Threads",
          `${session.threadUnreadCount ?? 0} unread · ${session.threadWaitingOnMeCount ?? 0} on me · ${session.threadWaitingOnThemCount ?? 0} on them · ${session.threadPendingCount ?? 0} pending`,
          width,
        ),
      );
    }
    if ((session.services?.length ?? 0) > 0) {
      lines.push(
        ...this.wrapKeyValue("Services", session.services!.map((s) => s.url ?? `:${s.port}`).join(", "), width),
      );
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private async graveyardSessionWithFeedback(sessionId: string, hasWorktrees: boolean): Promise<void> {
    const session = this.offlineSessions.find((s) => s.id === sessionId);
    if (!session) return;
    const label = session.label ?? session.command;
    await this.runDashboardOperation(
      `Sending "${label}" to graveyard`,
      [`  Session: ${session.id}`],
      () => {
        this.graveyardSession(sessionId);
        this.adjustAfterRemove(hasWorktrees);
        this.renderDashboard();
      },
      `Failed to graveyard "${label}"`,
    );
  }

  private async resumeOfflineSessionWithFeedback(session: SessionState): Promise<void> {
    const label = session.label ?? session.command;
    await this.runDashboardOperation(
      `Restoring "${label}"`,
      [`  Session: ${session.id}`],
      () => {
        this.resumeOfflineSession(session);
        this.focusSession(this.sessions.length - 1);
      },
      `Failed to restore "${label}"`,
    );
  }

  private async takeoverFromDashEntryWithFeedback(entry: DashboardSession): Promise<void> {
    const label = entry.label ?? entry.command;
    await this.runDashboardOperation(
      `Taking over "${label}"`,
      [`  Session: ${entry.id}`],
      () => this.takeoverSessionFromDashEntry(entry),
      `Failed to take over "${label}"`,
    );
  }

  private async migrateSessionWithFeedback(
    session: ManagedSession,
    targetPath: string,
    targetName: string,
  ): Promise<void> {
    const label = this.getSessionLabel(session.id) ?? session.command;
    await this.runDashboardOperation(
      `Migrating "${label}"`,
      [`  From: ${this.sessionWorktreePaths.get(session.id) ?? "(main)"}`, `  To: ${targetName}`],
      async () => {
        await this.migrateAgent(session.id, targetPath);
        await this.waitForSessionExit(session);
        this.renderDashboard();
      },
      `Failed to migrate "${label}"`,
    );
  }

  private handleMigratePickerKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    this.migratePickerActive = false;

    if (key === "escape") {
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }

    if (key >= "1" && key <= "9") {
      const idx = parseInt(key) - 1;
      if (idx < this.migratePickerWorktrees.length) {
        const target = this.migratePickerWorktrees[idx];
        const session = this.sessions[this.activeIndex];
        if (session) {
          void this.migrateSessionWithFeedback(session, target.path, target.name);
          return;
        }
      }
    }

    if (this.mode === "dashboard") {
      this.renderDashboard();
    } else if (this.sessions.length > 0) {
      this.focusSession(this.activeIndex);
    }
  }

  /** Get the current dashboard sessions (local + remote merged) for lookup */
  private getDashboardSessions(): DashboardSession[] {
    const metadata = loadMetadataState().sessions;
    const threadSummaries = listThreadSummaries();
    const threadStats = new Map<
      string,
      {
        unread: number;
        waiting: number;
        waitingOnMe: number;
        waitingOnThem: number;
        pending: number;
        latestId?: string;
        latestTitle?: string;
      }
    >();
    const workflowStats = new Map<
      string,
      {
        onMe: number;
        blocked: number;
        families: Set<string>;
        topUrgency: number;
        topLabel?: string;
      }
    >();
    for (const summary of threadSummaries) {
      const messages = readMessages(summary.thread.id);
      const pendingByParticipant = new Map<string, number>();
      for (const message of messages) {
        for (const recipient of message.to ?? []) {
          if (!(message.deliveredTo ?? []).includes(recipient)) {
            pendingByParticipant.set(recipient, (pendingByParticipant.get(recipient) ?? 0) + 1);
          }
        }
      }
      for (const participant of summary.thread.participants) {
        const current = threadStats.get(participant) ?? {
          unread: 0,
          waiting: 0,
          waitingOnMe: 0,
          waitingOnThem: 0,
          pending: 0,
        };
        if ((summary.thread.unreadBy ?? []).includes(participant)) current.unread += 1;
        const waitsOnParticipant = (summary.thread.waitingOn ?? []).includes(participant);
        const ownedByParticipant = summary.thread.owner === participant;
        if (waitsOnParticipant || ownedByParticipant) {
          current.waiting += 1;
        }
        if (waitsOnParticipant) current.waitingOnMe += 1;
        if (ownedByParticipant && (summary.thread.waitingOn?.length ?? 0) > 0) current.waitingOnThem += 1;
        current.pending += pendingByParticipant.get(participant) ?? 0;
        if (!current.latestId) {
          current.latestId = summary.thread.id;
          current.latestTitle = summary.thread.title;
        }
        threadStats.set(participant, current);
      }
    }
    for (const entry of buildWorkflowEntries("user")) {
      const familyKey = entry.familyRootTaskId ?? entry.thread.id;
      for (const participant of entry.thread.participants) {
        const current = workflowStats.get(participant) ?? {
          onMe: 0,
          blocked: 0,
          families: new Set<string>(),
          topUrgency: -1,
        };
        if ((entry.thread.waitingOn ?? []).includes(participant)) current.onMe += 1;
        if (entry.thread.status === "blocked" || entry.task?.status === "blocked") current.blocked += 1;
        if (entry.familyTaskIds.length > 1) current.families.add(familyKey);
        if (entry.urgency > current.topUrgency) {
          current.topUrgency = entry.urgency;
          current.topLabel = `${entry.displayTitle} (${entry.stateLabel})`;
        }
        workflowStats.set(participant, current);
      }
    }
    let mainRepoPath: string | undefined;
    try {
      mainRepoPath = findMainRepo();
    } catch {}
    return buildDashboardSessions({
      sessions: this.sessions.map((session) => ({
        id: session.id,
        command: session.command,
        backendSessionId: session.backendSessionId,
        status: session.status,
        worktreePath: this.sessionWorktreePaths.get(session.id),
      })),
      activeIndex: this.activeIndex,
      offlineSessions: this.offlineSessions,
      remoteInstances: [],
      mainRepoPath,
      getSessionLabel: (sessionId) => this.getSessionLabel(sessionId),
      getSessionHeadline: (sessionId) => this.deriveHeadline(sessionId),
      getSessionTaskDescription: (sessionId) => this.taskDispatcher?.getSessionTask(sessionId),
      getSessionRole: (sessionId) => this.sessionRoles.get(sessionId),
      getSessionContext: (sessionId) => metadata[sessionId]?.context,
      getSessionDerived: (sessionId) => metadata[sessionId]?.derived,
    }).map((session) => {
      const stats = threadStats.get(session.id);
      return {
        ...session,
        threadUnreadCount: stats?.unread ?? 0,
        threadWaitingCount: stats?.waiting ?? 0,
        threadWaitingOnMeCount: stats?.waitingOnMe ?? 0,
        threadWaitingOnThemCount: stats?.waitingOnThem ?? 0,
        threadPendingCount: stats?.pending ?? 0,
        threadId: session.threadId ?? stats?.latestId,
        threadName: session.threadName ?? stats?.latestTitle,
        workflowOnMeCount: workflowStats.get(session.id)?.onMe ?? 0,
        workflowBlockedCount: workflowStats.get(session.id)?.blocked ?? 0,
        workflowFamilyCount: workflowStats.get(session.id)?.families.size ?? 0,
        workflowTopLabel: workflowStats.get(session.id)?.topLabel,
      };
    });
  }

  private getDashboardSessionsInVisualOrder(): DashboardSession[] {
    const allDash = this.getDashboardSessions();

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
      const dir = getProjectStateDir();
      const filePath = join(dir, "statusline.json");
      const tmpPath = `${filePath}.tmp`;
      const data = this.buildStatuslineSnapshot();
      writeFileSync(tmpPath, JSON.stringify(data) + "\n");
      renameSync(tmpPath, filePath);
      this.tmuxRuntimeManager.refreshStatus();
    } catch {}
  }

  private buildStatuslineSnapshot(): {
    project: string;
    dashboardScreen: DashboardScreen;
    sessions: Array<{
      id: string;
      tool: string;
      label?: string;
      windowName: string;
      headline?: string;
      status: string;
      role?: string;
      active: boolean;
      worktreePath?: string;
    }>;
    tasks: { pending: number; assigned: number };
    flash: string | null;
    metadata: ReturnType<typeof loadMetadataState>["sessions"];
    updatedAt: string;
  } {
    return {
      project: basename(process.cwd()),
      dashboardScreen: this.dashboardState.screen,
      sessions: this.sessions.map((s, i) => ({
        id: s.id,
        tool: s.command,
        label: this.getSessionLabel(s.id),
        windowName: this.getSessionLabel(s.id) || s.command,
        headline: this.deriveHeadline(s.id),
        status: s.status,
        role: this.sessionRoles.get(s.id),
        active: i === this.activeIndex,
        worktreePath: this.sessionWorktreePaths.get(s.id),
      })),
      tasks: this.taskDispatcher?.getTaskCounts() ?? { pending: 0, assigned: 0 },
      flash: this.footerFlash,
      metadata: loadMetadataState().sessions,
      updatedAt: new Date().toISOString(),
    };
  }

  private buildDesktopState(): {
    sessions: DashboardSession[];
    statusline: ReturnType<Multiplexer["buildStatuslineSnapshot"]>;
    worktrees: Array<{ name: string; path: string; branch: string; isBare: boolean }>;
  } {
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();
    return {
      sessions: this.getDashboardSessions(),
      statusline: this.buildStatuslineSnapshot(),
      worktrees: this.listDesktopWorktrees(),
    };
  }

  private listDesktopWorktrees(): Array<{ name: string; path: string; branch: string; isBare: boolean }> {
    return listAllWorktrees().filter((wt) => !wt.isBare);
  }

  async removeDesktopWorktree(path: string): Promise<{ path: string }> {
    this.restoreTmuxSessionsFromState();
    this.loadOfflineSessions();

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
    return text.replace(/\x1b\[[0-9;]*m/g, "");
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
  private footerFlash: string | null = null;
  private footerFlashTicks = 0;

  private startStatusRefresh(): void {
    if (this.statusInterval) return;
    this.statusInterval = setInterval(() => {
      this.taskDispatcher?.tick(this.sessions.map((s) => s.id));
      this.orchestrationDispatcher?.tick(this.sessions.map((s) => s.id));
      if (this.mode === "project-service") {
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
      }

      const orchestrationEvents = this.orchestrationDispatcher?.drainEvents() ?? [];
      for (const event of orchestrationEvents) {
        if (event.type === "message_delivered") {
          this.footerFlash = `✉ Message delivered → ${event.sessionId}`;
          this.footerFlashTicks = 3;
        }
      }

      if (this.footerFlashTicks > 0) this.footerFlashTicks--;
      if (this.footerFlashTicks === 0) this.footerFlash = null;

      for (const session of this.sessions) {
        const prev = this.prevStatuses.get(session.id);
        const curr = session.status;
        if (prev && prev !== curr && curr === "idle" && prev === "running") {
          notifyPrompt(session.id);
        }
        this.prevStatuses.set(session.id, curr);
      }

      if (this.mode === "dashboard") {
        this.renderCurrentDashboardView();
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
  private loadOfflineSessions(): void {
    const state = Multiplexer.loadState();
    if (!state || state.sessions.length === 0) return;

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

    this.offlineSessions = state.sessions.filter((s) => {
      if (ownedIds.has(s.id)) return false;
      if (s.backendSessionId && ownedBackendIds.has(s.backendSessionId)) return false;
      return true;
    });

    if (this.offlineSessions.length > 0) {
      debug(`loaded ${this.offlineSessions.length} offline session(s) from state.json`, "session");
    }
  }

  private restoreTmuxSessionsFromState(): void {
    const state = Multiplexer.loadState();
    const savedById = new Map((state?.sessions ?? []).map((session) => [session.id, session]));

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const tmuxSession = this.tmuxRuntimeManager.getProjectSession(process.cwd());

    for (const { target, metadata } of this.tmuxRuntimeManager.listManagedWindows(tmuxSession.sessionName)) {
      if (isDashboardWindowName(target.windowName)) continue;
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
        transport.renameWindow(label);
      }
      this.syncTmuxWindowMetadata(metadata.sessionId);
    }
  }

  /** Remove an offline session and move it to state-trash.json */
  /** Stop a running session and move it to offline (first [x]) */
  private stopSessionToOffline(session: ManagedSession): void {
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
    this.offlineSessions.push(offlineEntry);

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
      if (this.dashboardState.worktreeSessions.length === 0) {
        // No more agents in this worktree — step back to worktree level
        this.dashboardState.level = "worktrees";
      } else if (this.dashboardState.sessionIndex >= this.dashboardState.worktreeSessions.length) {
        this.dashboardState.sessionIndex = this.dashboardState.worktreeSessions.length - 1;
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

  /** Resume a specific offline session */
  private resumeOfflineSession(session: SessionState): void {
    const config = loadConfig();
    const toolCfg = config.tools[session.toolConfigKey];
    if (!toolCfg) return;

    let actionArgs: string[];
    if (this.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, session.backendSessionId)) {
      actionArgs = toolCfg.resumeArgs!.map((a: string) => a.replace("{sessionId}", session.backendSessionId!));
    } else {
      actionArgs = [...(toolCfg.resumeFallback ?? [])];
    }
    const args = this.sessionBootstrap.composeToolArgs(toolCfg, actionArgs, session.args);

    // Remove from offline list
    this.offlineSessions = this.offlineSessions.filter((s) => s.id !== session.id);

    debug(`resuming offline session ${session.id} (backend=${session.backendSessionId ?? "none"})`, "session");
    this.createSession(
      session.command,
      args,
      toolCfg.preambleFlag,
      session.toolConfigKey,
      undefined,
      undefined, // don't pass sessionIdFlag — we're resuming with existing backend ID
      session.worktreePath,
      session.backendSessionId,
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      if (this.mode === "project-service") {
        this.restoreTmuxSessionsFromState();
        this.loadOfflineSessions();
        return;
      }
      const sessions = this.getInstanceSessionRefs();
      this.instanceDirectory
        .reconcileHeartbeat(this.instanceId, sessions, process.cwd(), this.confirmedRegistered)
        .then((result) => {
          for (const id of result.claimedIds) {
            debug(`session ${id} claimed: was in confirmedRegistered but not in previousIds`, "instance");
            this.handleSessionClaimed(id);
          }
          if (result.skippedClaimDetection && this.confirmedRegistered.size > 0) {
            debug(
              `skipping claim detection: previousIds empty but ${this.confirmedRegistered.size} confirmed sessions (registry entry may have been pruned)`,
              "instance",
            );
          }
          this.confirmedRegistered = result.confirmedIds;
        })
        .catch(() => {});
      // Refresh offline sessions from state.json (picks up cross-instance graveyard/kill)
      this.loadOfflineSessions();
      // Refresh dashboard to pick up remote instance changes (skip if overlay is active)
      if (this.mode === "dashboard") {
        this.renderCurrentDashboardView();
      }
    }, 5000);
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
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private startProjectServiceRefresh(): void {
    if (this.projectServiceInterval) return;
    this.projectServiceInterval = setInterval(() => {
      this.restoreTmuxSessionsFromState();
      this.loadOfflineSessions();
      this.writeStatuslineFile();
    }, 2000);
  }

  private stopProjectServiceRefresh(): void {
    if (this.projectServiceInterval) {
      clearInterval(this.projectServiceInterval);
      this.projectServiceInterval = null;
    }
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
    if (mySessions.length === 0) return;

    // Merge with existing state (other instances may have written their sessions)
    const statePath = Multiplexer.getSharedStatePath();
    let mergedSessions: SessionState[] = mySessions;

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
      } catch {
        // Corrupt file — just overwrite with ours
      }
    }

    const state: SavedState = {
      savedAt: new Date().toISOString(),
      cwd: process.cwd(),
      sessions: mergedSessions,
    };

    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
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
}

/** Check if a command is available on PATH */
function isToolAvailable(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
