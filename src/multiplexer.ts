import {
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  cpSync,
  copyFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { PtySession, type PtySessionOptions } from "./pty-session.js";
import { HotkeyHandler, type HotkeyAction } from "./hotkeys.js";
import { Dashboard, type DashboardSession, type WorktreeGroup } from "./dashboard.js";
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
} from "./paths.js";
import { debug, debugPreamble, closeDebug } from "./debug.js";
import { createWorktree, findMainRepo, listWorktrees as listAllWorktrees } from "./worktree.js";
import { notifyPrompt, notifyComplete } from "./notify.js";
import {
  registerInstance,
  unregisterInstance,
  updateHeartbeat,
  getRemoteInstances,
  claimSession,
  type InstanceSessionRef,
} from "./instance-registry.js";
import { TaskDispatcher, requestReview } from "./task-dispatcher.js";
import { loadTeamConfig } from "./team.js";
import { scanAllProjects } from "./project-scanner.js";
import { ServerClient } from "./server-client.js";
import { FooterPluginManager, type FooterPluginContext } from "./footer-plugins.js";

export type MuxMode = "focused" | "dashboard";

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
}

export interface SavedState {
  savedAt: string;
  cwd: string;
  sessions: SessionState[];
}

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

export class Multiplexer {
  private sessions: PtySession[] = [];
  private activeIndex = 0;
  private mode: MuxMode = "focused";
  private rawModeWas: boolean | undefined;
  private hotkeys: HotkeyHandler;
  private dashboard: Dashboard;
  private onStdinData: ((data: Buffer) => void) | null = null;
  private onResize: (() => void) | null = null;
  private resolveRun: ((code: number) => void) | null = null;
  private defaultCommand: string = "";
  private defaultArgs: string[] = [];
  private startedInDashboard = false;
  private pickerActive = false;
  private worktreeInputActive = false;
  private worktreeInputBuffer = "";
  private labelInputActive = false;
  private labelInputBuffer = "";
  private labelInputTarget: string | null = null;
  private worktreeListActive = false;
  private worktreeRemoveConfirm: { path: string; name: string } | null = null;
  private worktreeRemovalJob: WorktreeRemovalJob | null = null;
  private dashboardBusyState: DashboardBusyState | null = null;
  private dashboardBusySpinner: ReturnType<typeof setInterval> | null = null;
  private dashboardErrorState: DashboardErrorState | null = null;
  private migratePickerActive = false;
  private migratePickerWorktrees: Array<{ name: string; path: string }> = [];
  private graveyardActive = false;
  private graveyardEntries: SessionState[] = [];
  private metaDashboardActive = false;
  /** Quick switcher overlay state */
  private switcherActive = false;
  private switcherIndex = 0;
  private switcherTimeout: ReturnType<typeof setTimeout> | null = null;
  /** MRU order of session IDs (most recent first) */
  private sessionMRU: string[] = [];
  /** Sessions confirmed registered in the instance registry (for claim detection) */
  private confirmedRegistered = new Set<string>();
  /** The focused worktree path on the dashboard (undefined = main repo) */
  private focusedWorktreePath: string | undefined = undefined;
  /** Ordered list of worktree paths for navigation (undefined = main repo) */
  private worktreeNavOrder: Array<string | undefined> = [];
  /** Dashboard navigation level: worktrees (top) or sessions (inside a worktree) */
  private dashboardLevel: "worktrees" | "sessions" = "worktrees";
  /** Index within sessions of the focused worktree */
  private dashboardSessionIndex = 0;
  /** Sessions in the currently focused worktree (for session-level nav) */
  private dashboardWorktreeSessions: DashboardSession[] = [];
  private footerInterval: ReturnType<typeof setInterval> | null = null;
  private footerPlugins: FooterPluginManager;
  private footerSessionScope: "worktree" | "project";
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private instanceId = randomUUID();
  private contextWatcher = new ContextWatcher();
  private taskDispatcher: TaskDispatcher | null = null;
  /** Maps session ID → toolConfigKey for state saving */
  private sessionToolKeys = new Map<string, string>();
  /** Maps session ID → original args (before preamble injection) */
  private sessionOriginalArgs = new Map<string, string[]>();
  /** Track session spawn time for quick-crash detection */
  private sessionStartTimes = new Map<string, number>();
  /** Maps session ID → worktree path (if session runs in a worktree) */
  private sessionWorktreePaths = new Map<string, string>();
  /** Maps session ID → team role (e.g. "coder", "reviewer") */
  private sessionRoles = new Map<string, string>();
  /** Maps session ID → user-provided stable label */
  private sessionLabels = new Map<string, string>();
  /** Offline sessions from previous runs (loaded from state.json) */
  private offlineSessions: SessionState[] = [];
  /** Server client for persistent PTY ownership */
  private serverClient: ServerClient | null = null;
  /** Session IDs owned by the server (don't kill on TUI exit) */
  private serverSessionIds = new Set<string>();

  constructor() {
    this.hotkeys = new HotkeyHandler((action) => this.handleAction(action));
    this.dashboard = new Dashboard();
    const footerConfig = loadConfig().footer;
    this.footerSessionScope = footerConfig.sessionScope;
    this.footerPlugins = new FooterPluginManager(footerConfig.plugins, () => {
      if (this.mode === "focused") this.renderFooter();
    });
  }

  get activeSession(): PtySession | null {
    return this.sessions[this.activeIndex] ?? null;
  }

  get sessionCount(): number {
    return this.sessions.length;
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

    if (this.serverSessionIds.has(sessionId) && this.serverClient?.connected) {
      const ok = await this.serverClient.renameSession(sessionId, label?.trim() || undefined);
      if (!ok) {
        this.footerFlash = `Failed to rename ${sessionId}`;
        this.footerFlashTicks = 3;
      }
    }

    this.saveState();
    this.writeStatuslineFile();

    if (this.mode === "dashboard") {
      this.renderDashboard();
    } else if (this.mode === "focused") {
      this.focusSession(this.activeIndex);
    }
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
    session: PtySession,
    args: string[],
    toolConfigKey?: string,
    worktreePath?: string,
    role?: string,
    startTime?: number,
  ): void {
    if (this.sessions.includes(session)) return;

    if (startTime !== undefined) {
      this.sessionStartTimes.set(session.id, startTime);
    }

    // Forward output to stdout only when this session is active and focused
    session.onData((data) => {
      if (this.mode === "focused" && this.sessions[this.activeIndex] === session) {
        process.stdout.write(data);
      }
    });

    // Handle session exit
    session.onExit((_code) => {
      debug(`session exited: ${session.id} (code=${_code})`, "session");

      // Detect quick crash: non-zero exit within 10s of spawn
      const start = this.sessionStartTimes.get(session.id);
      const uptime = start ? Date.now() - start : Infinity;
      if (_code !== 0 && uptime < 10_000) {
        let errorHint = "";
        const sessionCwd = this.sessionWorktreePaths.get(session.id);
        const searchDirs = [getProjectStateDir(), sessionCwd ? getAimuxDirFor(sessionCwd) : null].filter(
          Boolean,
        ) as string[];
        for (const dir of searchDirs) {
          if (errorHint) break;
          try {
            const logPath = join(dir, "recordings", `${session.id}.log`);
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
        this.footerFlash = `\x1b[31m✗ ${session.id} crashed (code ${_code})${errorHint}\x1b[0m`;
        this.footerFlashTicks = 8;
        debug(`quick crash: ${session.id} (code=${_code}, uptime=${uptime}ms)${errorHint}`, "session");
      }
      this.sessionStartTimes.delete(session.id);

      notifyComplete(session.id);
      captureGitContext(session.id, session.command).catch(() => {});

      const idx = this.sessions.indexOf(session);
      if (idx === -1) return;

      this.sessions.splice(idx, 1);
      this.writeSessionsFile();
      this.updateContextWatcherSessions();

      if (this.sessions.length === 0) {
        if (this.startedInDashboard) {
          this.setMode("dashboard");
          return;
        }
        this.resolveRun?.(_code);
        return;
      }

      if (this.activeIndex >= this.sessions.length) {
        this.activeIndex = this.sessions.length - 1;
      }

      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
    });

    if (toolConfigKey) {
      this.sessionToolKeys.set(session.id, toolConfigKey);
    }
    this.sessionOriginalArgs.set(session.id, args);
    if (worktreePath) {
      this.sessionWorktreePaths.set(session.id, worktreePath);
    }
    if (role) {
      this.sessionRoles.set(session.id, role);
    } else if (!this.sessionRoles.has(session.id)) {
      try {
        const teamConfig = loadTeamConfig();
        this.sessionRoles.set(session.id, teamConfig.defaultRole);
      } catch {}
    }
    const label = this.offlineSessions.find((offline) => offline.id === session.id)?.label;
    if (label) {
      this.sessionLabels.set(session.id, label);
    }

    this.sessions.push(session);
    this.writeSessionsFile();
    this.updateContextWatcherSessions();
    if (this.sessions.length === 1) this.contextWatcher.start();
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
        };
      }),
    );
  }

  /** Try to connect to a running aimux server for persistent PTY ownership */
  private async connectToServer(): Promise<void> {
    if (!ServerClient.isAvailable()) return;
    try {
      this.serverClient = new ServerClient();
      await this.serverClient.connect();
      this.serverClient.onSessionUpdated(({ id, label }) => {
        this.applySessionLabel(id, label);
        this.writeStatuslineFile();
        if (this.mode === "dashboard" && !this.metaDashboardActive && !this.graveyardActive) {
          this.renderDashboard();
        } else if (this.mode === "focused") {
          this.renderFooter();
        }
      });
      debug("connected to aimux server", "server-client");

      // Reconnect to existing server sessions
      const serverSessions = await this.serverClient.listSessions();
      const cols = process.stdout.columns ?? 80;
      const rows = this.toolRows;
      for (const info of serverSessions) {
        if (info.exited) continue;
        // Build prompt patterns from config
        let promptPatterns: RegExp[] | undefined;
        const config = loadConfig();
        const toolEntry = Object.entries(config.tools).find(([, t]) => t.command === info.command);
        if (toolEntry?.[1]?.promptPatterns) {
          promptPatterns = toolEntry[1].promptPatterns.map((p: string) => new RegExp(p, "m"));
        }
        const session = this.serverClient.registerSession(info.id, info.command, cols, rows, promptPatterns);
        session.backendSessionId = info.backendSessionId;
        this.serverSessionIds.add(info.id);
        try {
          const screen = await this.serverClient.requestScreen(info.id);
          session._hydrateScreen(screen);
        } catch {}
        this.registerManagedSession(
          session as any,
          [],
          info.toolConfigKey ?? info.command,
          info.worktreePath,
          undefined,
        );
        if (info.label) {
          const state = this.offlineSessions.find((s) => s.id === info.id);
          if (state) state.label = info.label;
          this.sessionLabels.set(info.id, info.label);
        }
        debug(`reconnected to server session: ${info.id}`, "server-client");
      }
    } catch {
      debug("could not connect to server, using direct PTY mode", "server-client");
      this.serverClient = null;
    }
  }

  async run(opts: Omit<PtySessionOptions, "cols" | "rows">): Promise<number> {
    initProject();
    await registerInstance(this.instanceId, process.cwd());
    this.startHeartbeat();
    await this.connectToServer();
    this.taskDispatcher = new TaskDispatcher(
      (id) => this.sessions.find((s) => s.id === id),
      (id) => this.sessionToolKeys.get(id),
      (id) => this.sessionRoles.get(id),
    );
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

    // Enter raw mode and set up footer
    this.enterRawMode();
    this.setupScrollRegion();
    this.startFooterRefresh();

    // Forward stdin through hotkey handler → active PTY
    this.onStdinData = (data: Buffer) => {
      if (this.pickerActive) {
        this.handleToolPickerKey(data);
        return;
      }
      if (this.worktreeRemoveConfirm) {
        this.handleWorktreeRemoveConfirmKey(data);
        return;
      }
      if (this.worktreeInputActive) {
        this.handleWorktreeInputKey(data);
        return;
      }
      if (this.worktreeListActive) {
        this.handleWorktreeListKey(data);
        return;
      }
      if (this.migratePickerActive) {
        this.handleMigratePickerKey(data);
        return;
      }
      if (this.switcherActive) {
        this.handleSwitcherKey(data);
        return;
      }
      if (this.labelInputActive) {
        this.handleLabelInputKey(data);
        return;
      }
      if (this.metaDashboardActive) {
        this.handleMetaDashboardKey(data);
        return;
      }
      if (this.graveyardActive) {
        this.handleGraveyardKey(data);
        return;
      }

      if (this.mode === "dashboard") {
        this.handleDashboardKey(data);
        return;
      }

      const passthrough = this.hotkeys.feed(data);
      if (passthrough !== null) {
        this.activeSession?.write(passthrough);
      }
    };
    process.stdin.on("data", this.onStdinData);

    // Forward terminal resize → all PTYs + redraw footer/dashboard
    this.onResize = () => {
      const cols = process.stdout.columns ?? 80;
      for (const session of this.sessions) {
        session.resize(cols, this.toolRows);
      }
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.setupScrollRegion();
        this.renderFooter();
      }
    };
    process.stdout.on("resize", this.onResize);

    // Wait until all sessions exit or explicit quit
    const exitCode = await new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });

    // Cleanup
    this.teardown();
    return exitCode;
  }

  async runDashboard(): Promise<number> {
    initProject();
    await registerInstance(this.instanceId, process.cwd());
    this.startHeartbeat();
    await this.connectToServer();
    this.loadOfflineSessions();
    this.startedInDashboard = true;

    // Load config to set default tool for session creation
    const config = loadConfig();
    const defaultTool = config.tools[config.defaultTool];
    if (defaultTool) {
      this.defaultCommand = defaultTool.command;
      this.defaultArgs = defaultTool.args;
    }

    this.writeInstructionFiles();
    this.enterRawMode();

    // Forward stdin
    this.onStdinData = (data: Buffer) => {
      if (this.pickerActive) {
        this.handleToolPickerKey(data);
        return;
      }
      if (this.worktreeRemoveConfirm) {
        this.handleWorktreeRemoveConfirmKey(data);
        return;
      }
      if (this.worktreeInputActive) {
        this.handleWorktreeInputKey(data);
        return;
      }
      if (this.worktreeListActive) {
        this.handleWorktreeListKey(data);
        return;
      }
      if (this.migratePickerActive) {
        this.handleMigratePickerKey(data);
        return;
      }
      if (this.switcherActive) {
        this.handleSwitcherKey(data);
        return;
      }
      if (this.labelInputActive) {
        this.handleLabelInputKey(data);
        return;
      }
      if (this.metaDashboardActive) {
        this.handleMetaDashboardKey(data);
        return;
      }
      if (this.graveyardActive) {
        this.handleGraveyardKey(data);
        return;
      }

      if (this.mode === "dashboard") {
        this.handleDashboardKey(data);
        return;
      }

      const passthrough = this.hotkeys.feed(data);
      if (passthrough !== null) {
        this.activeSession?.write(passthrough);
      }
    };
    process.stdin.on("data", this.onStdinData);

    // Forward terminal resize
    this.onResize = () => {
      const cols = process.stdout.columns ?? 80;
      for (const session of this.sessions) {
        session.resize(cols, this.toolRows);
      }
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.setupScrollRegion();
        this.renderFooter();
      }
    };
    process.stdout.on("resize", this.onResize);

    // Enter dashboard mode directly
    this.mode = "dashboard";
    process.stdout.write("\x1b[?1049h");
    this.renderDashboard();

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
    await registerInstance(this.instanceId, process.cwd());
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

    // Collect session IDs owned by other live instances
    const ownedByOthers = new Set<string>();
    try {
      const remote = getRemoteInstances(this.instanceId, process.cwd());
      for (const inst of remote) {
        for (const rs of inst.sessions) {
          ownedByOthers.add(rs.id);
          if (rs.backendSessionId) ownedByOthers.add(rs.backendSessionId);
        }
      }
    } catch {}

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
      if (bsid) {
        // Substitute backend session ID into resume args
        resumeArgs = (toolCfg.resumeArgs ?? []).map((a: string) => a.replace("{sessionId}", bsid));
      } else {
        // No backend session ID — use tool's configured fallback
        resumeArgs = toolCfg.resumeFallback ?? [];
      }
      const args = [...resumeArgs, ...saved.args];
      debug(`resuming ${saved.command} with backendSessionId=${bsid ?? "none (fallback)"}`, "session");
      this.createSession(
        saved.command,
        args,
        toolCfg.preambleFlag,
        saved.toolConfigKey,
        undefined,
        undefined,
        saved.worktreePath,
      );
    }

    // Enter raw mode and set up input handling
    this.enterRawMode();
    this.setupScrollRegion();
    this.startFooterRefresh();

    this.onStdinData = (data: Buffer) => {
      if (this.pickerActive) {
        this.handleToolPickerKey(data);
        return;
      }
      if (this.worktreeRemoveConfirm) {
        this.handleWorktreeRemoveConfirmKey(data);
        return;
      }
      if (this.worktreeInputActive) {
        this.handleWorktreeInputKey(data);
        return;
      }
      if (this.worktreeListActive) {
        this.handleWorktreeListKey(data);
        return;
      }
      if (this.migratePickerActive) {
        this.handleMigratePickerKey(data);
        return;
      }
      if (this.switcherActive) {
        this.handleSwitcherKey(data);
        return;
      }
      if (this.labelInputActive) {
        this.handleLabelInputKey(data);
        return;
      }
      if (this.metaDashboardActive) {
        this.handleMetaDashboardKey(data);
        return;
      }
      if (this.graveyardActive) {
        this.handleGraveyardKey(data);
        return;
      }
      if (this.mode === "dashboard") {
        this.handleDashboardKey(data);
        return;
      }
      const passthrough = this.hotkeys.feed(data);
      if (passthrough !== null) {
        this.activeSession?.write(passthrough);
      }
    };
    process.stdin.on("data", this.onStdinData);

    this.onResize = () => {
      const cols = process.stdout.columns ?? 80;
      for (const session of this.sessions) {
        session.resize(cols, this.toolRows);
      }
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.setupScrollRegion();
        this.renderFooter();
      }
    };
    process.stdout.on("resize", this.onResize);

    const exitCode = await new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });

    this.teardown();
    return exitCode;
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

    // Enter raw mode and set up input handling
    this.enterRawMode();
    this.setupScrollRegion();
    this.startFooterRefresh();

    this.onStdinData = (data: Buffer) => {
      if (this.pickerActive) {
        this.handleToolPickerKey(data);
        return;
      }
      if (this.worktreeRemoveConfirm) {
        this.handleWorktreeRemoveConfirmKey(data);
        return;
      }
      if (this.worktreeInputActive) {
        this.handleWorktreeInputKey(data);
        return;
      }
      if (this.worktreeListActive) {
        this.handleWorktreeListKey(data);
        return;
      }
      if (this.migratePickerActive) {
        this.handleMigratePickerKey(data);
        return;
      }
      if (this.switcherActive) {
        this.handleSwitcherKey(data);
        return;
      }
      if (this.labelInputActive) {
        this.handleLabelInputKey(data);
        return;
      }
      if (this.metaDashboardActive) {
        this.handleMetaDashboardKey(data);
        return;
      }
      if (this.graveyardActive) {
        this.handleGraveyardKey(data);
        return;
      }
      if (this.mode === "dashboard") {
        this.handleDashboardKey(data);
        return;
      }
      const passthrough = this.hotkeys.feed(data);
      if (passthrough !== null) {
        this.activeSession?.write(passthrough);
      }
    };
    process.stdin.on("data", this.onStdinData);

    this.onResize = () => {
      const cols = process.stdout.columns ?? 80;
      for (const session of this.sessions) {
        session.resize(cols, this.toolRows);
      }
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.setupScrollRegion();
        this.renderFooter();
      }
    };
    process.stdout.on("resize", this.onResize);

    const exitCode = await new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });

    this.teardown();
    return exitCode;
  }

  createSession(
    command: string,
    args: string[],
    preambleFlag?: string[],
    toolConfigKey?: string,
    extraPreamble?: string,
    sessionIdFlag?: string[],
    worktreePath?: string,
  ): PtySession {
    const cols = process.stdout.columns ?? 80;

    // Pre-generate session ID so we can reference it in the preamble
    const sessionId = `${command}-${Math.random().toString(36).slice(2, 8)}`;

    // Generate a backend session UUID for tools that support it (e.g. claude --session-id)
    const backendSessionId = sessionIdFlag ? randomUUID() : undefined;

    // Inject aimux preamble via tool-specific flag if available
    let preamble =
      "You are running inside aimux, an agent multiplexer. " +
      "Other agents may be working on this codebase simultaneously.\n" +
      `Your session ID is ${sessionId}.\n` +
      `- .aimux/context/${sessionId}/live.md — your recent conversation history\n` +
      `- .aimux/context/${sessionId}/summary.md — your compacted history\n` +
      "- .aimux/sessions.json — all running agents\n" +
      "- Other agent contexts are in .aimux/context/{their-session-id}/. Check sessions.json for the list.\n" +
      "- .aimux/history/ — full raw conversation history (JSONL)";

    // Append user preamble from AIMUX.md: global (~/) then project (./)
    const globalAimuxMd = join(homedir(), "AIMUX.md");
    const projectAimuxMd = join(process.cwd(), "AIMUX.md");
    for (const mdPath of [globalAimuxMd, projectAimuxMd]) {
      if (existsSync(mdPath)) {
        try {
          const userPreamble = readFileSync(mdPath, "utf-8").trim();
          if (userPreamble) {
            preamble += "\n\n" + userPreamble;
            debug(`loaded ${mdPath} (${userPreamble.length} chars)`, "preamble");
          }
        } catch {}
      }
    }

    // Add worktree context to preamble
    if (worktreePath) {
      try {
        const allWt = listAllWorktrees(worktreePath);
        const thisWt = allWt.find((w) => w.path === worktreePath);
        const mainWt = allWt[0]; // first entry is always the main worktree
        const siblings = allWt
          .filter((w) => w.path !== worktreePath)
          .map((w) => `${w.name} (${w.branch})`)
          .join(", ");
        preamble +=
          `\n\nYou are working in git worktree "${thisWt?.name ?? basename(worktreePath)}" at ${worktreePath} on branch "${thisWt?.branch ?? "unknown"}".` +
          `\nMain repository: ${mainWt?.path ?? "unknown"}.` +
          (siblings ? `\nSibling worktrees: ${siblings}` : "") +
          `\nStay in your worktree directory.`;
      } catch {
        preamble += `\n\nYou are working in a git worktree at ${worktreePath}. Stay in this directory.`;
      }
    }

    preamble +=
      "\n\n## Status\n" +
      "Maintain a status file at .aimux/status/" +
      sessionId +
      ".md (3-5 lines max).\n" +
      "Update it whenever your focus changes. Include:\n" +
      "- What you're currently working on\n" +
      "- Key files involved\n" +
      "- Current state (investigating, implementing, testing, blocked, etc.)";

    preamble +=
      "\n\n## Aimux Cross-Agent Delegation\n" +
      "IMPORTANT: This is the aimux delegation system for coordinating work across agents in this multiplexer. " +
      "It is separate from any built-in task/todo features in your own tool.\n\n" +
      "### Delegating work to another agent\n" +
      "When asked to delegate, hand off, or assign work to another agent, create a JSON file:\n" +
      "```\n" +
      ".aimux/tasks/{short-descriptive-name}.json\n" +
      "```\n" +
      "Contents:\n" +
      "```json\n" +
      '{\n  "id": "{same as filename without .json}",\n  "status": "pending",\n' +
      '  "assignedBy": "' +
      sessionId +
      '",\n' +
      '  "description": "Brief summary of the task",\n' +
      '  "prompt": "Detailed instructions for the other agent",\n' +
      '  "createdAt": "{ISO timestamp}",\n  "updatedAt": "{ISO timestamp}"\n}\n' +
      "```\n" +
      "Optional fields: `assignedTo` (target session ID), `tool` (preferred tool type).\n" +
      "Aimux will automatically dispatch pending tasks to idle agents and inject the prompt.\n" +
      "Check .aimux/sessions.json for available agents and their session IDs.\n\n" +
      "### Receiving a delegated task\n" +
      "When you see `[AIMUX TASK ...]` in your input, another agent delegated work to you.\n" +
      "Complete the work, then update the task file:\n" +
      '- Success: set `status` to `"done"` and add a `result` field with a summary\n' +
      '- Failure: set `status` to `"failed"` and add an `error` field\n' +
      "The delegating agent will be notified automatically.";

    if (extraPreamble) {
      preamble += "\n" + extraPreamble;
    }

    let finalArgs = preambleFlag ? [...args, ...preambleFlag, preamble] : [...args];

    // Inject backend session ID flag (e.g. --session-id <uuid>)
    if (sessionIdFlag && backendSessionId) {
      const expandedFlag = sessionIdFlag.map((a) => a.replace("{sessionId}", backendSessionId));
      finalArgs = [...finalArgs, ...expandedFlag];
    }

    if (preambleFlag) {
      debugPreamble(command, Buffer.byteLength(preamble));
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

    // Build prompt patterns from config for status detection
    let promptPatterns: RegExp[] | undefined;
    if (toolConfigKey) {
      const tc = loadConfig().tools[toolConfigKey];
      if (tc?.promptPatterns) {
        promptPatterns = tc.promptPatterns.map((p) => new RegExp(p, "m"));
      }
    }

    let session: PtySession;

    // If server is connected, spawn on server for persistent ownership
    if (this.serverClient?.connected) {
      const serverSession = this.serverClient.registerSession(sessionId, command, cols, this.toolRows, promptPatterns);
      // Fire off the spawn request (async, but session is immediately usable for I/O)
      this.serverClient.send({
        type: "spawn",
        id: sessionId,
        command,
        args: finalArgs,
        toolConfigKey: toolConfigKey ?? command,
        backendSessionId,
        worktreePath,
        cwd: worktreePath ?? process.cwd(),
        cols,
        rows: this.toolRows,
      });
      session = serverSession as any;
      this.serverSessionIds.add(sessionId);
      debug(`spawned session on server: ${sessionId}`, "server-client");
    } else {
      session = new PtySession({
        command,
        args: finalArgs,
        cols,
        rows: this.toolRows,
        id: sessionId,
        cwd: worktreePath,
        promptPatterns,
      });
    }

    // Store backend session ID and start time
    session.backendSessionId = backendSessionId;
    const sessionStartTime = Date.now();

    // For tools without sessionIdFlag, try to capture the backend session ID via filesystem
    if (!backendSessionId && toolConfigKey) {
      const toolCfg = loadConfig().tools[toolConfigKey];
      if (toolCfg?.sessionCapture) {
        this.captureSessionId(session, toolCfg.sessionCapture);
      }
    }

    this.registerManagedSession(session, args, toolConfigKey, worktreePath, undefined, sessionStartTime);

    // Focus the new session
    this.activeIndex = this.sessions.length - 1;
    if (this.mode === "dashboard") {
      // Stay in dashboard but update it
      this.renderDashboard();
    } else if (this.sessions.length > 1) {
      this.focusSession(this.activeIndex);
    }

    return session;
  }

  /**
   * Migrate an agent from its current worktree to a target worktree.
   * Copies history and context, kills the old session, starts a new one
   * with injected prior history.
   */
  migrateAgent(sessionId: string, targetWorktreePath: string): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const sourceWorktree = this.sessionWorktreePaths.get(sessionId);
    const sourceCwd = sourceWorktree ?? process.cwd();

    // Copy history file
    const sourceHistoryPath = join(getProjectStateDir(), "history", `${sessionId}.jsonl`);
    const targetHistoryDir = join(getAimuxDirFor(targetWorktreePath), "history");
    mkdirSync(targetHistoryDir, { recursive: true });
    if (existsSync(sourceHistoryPath)) {
      copyFileSync(sourceHistoryPath, join(targetHistoryDir, `${sessionId}.jsonl`));
    }

    // Copy context directory
    const sourceContextDir = join(getProjectStateDir(), "context", sessionId);
    const targetContextDir = join(getAimuxDirFor(targetWorktreePath), "context", sessionId);
    if (existsSync(sourceContextDir)) {
      cpSync(sourceContextDir, targetContextDir, { recursive: true });
    }

    // Get tool config for the session
    const toolConfigKey = this.sessionToolKeys.get(sessionId) ?? session.command;
    const config = loadConfig();
    const toolCfg = config.tools[toolConfigKey];
    const originalArgs = this.sessionOriginalArgs.get(sessionId) ?? [];

    // Build history preamble (same pattern as restoreSessions)
    const turns = readHistory(sessionId, { lastN: 20 });
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
        "You were previously working in a different worktree. Here's what happened:\n" +
        formattedTurns.join("\n") +
        "\n=== End previous context ===\n";
    }

    // Kill the old session
    debug(`migrating session ${sessionId} from ${sourceCwd} to ${targetWorktreePath}`, "session");
    session.kill();

    // Start new session in target worktree
    // If target is the main repo (cwd), pass undefined so it's not treated as a worktree
    const effectiveTarget = targetWorktreePath === process.cwd() ? undefined : targetWorktreePath;
    this.createSession(
      session.command,
      originalArgs,
      toolCfg?.preambleFlag,
      toolConfigKey,
      historyContext.trim() || undefined,
      toolCfg?.sessionIdFlag,
      effectiveTarget,
    );
  }

  /** Get worktree path for a session */
  getSessionWorktreePath(sessionId: string): string | undefined {
    return this.sessionWorktreePaths.get(sessionId);
  }

  /** Get all sessions grouped by worktree path */
  getSessionsByWorktree(): Map<string | undefined, PtySession[]> {
    const groups = new Map<string | undefined, PtySession[]>();
    for (const session of this.sessions) {
      const wtPath = this.sessionWorktreePaths.get(session.id);
      const group = groups.get(wtPath) ?? [];
      group.push(session);
      groups.set(wtPath, group);
    }
    return groups;
  }

  private getScopedSessionEntries(): Array<{ session: PtySession; index: number }> {
    if (this.footerSessionScope === "project") {
      return this.sessions.map((session, index) => ({ session, index }));
    }

    const activeSession = this.sessions[this.activeIndex];
    if (!activeSession) {
      return this.sessions.map((session, index) => ({ session, index }));
    }

    const activeWorktreePath = this.sessionWorktreePaths.get(activeSession.id);
    return this.sessions
      .map((session, index) => ({ session, index }))
      .filter(({ session }) => this.sessionWorktreePaths.get(session.id) === activeWorktreePath);
  }

  private focusSession(index: number): void {
    if (index < 0 || index >= this.sessions.length) return;

    this.activeIndex = index;
    this.setMode("focused");

    // Update MRU: move focused session to front
    const sid = this.sessions[index].id;
    this.sessionMRU = [sid, ...this.sessionMRU.filter((id) => id !== sid)];

    // Set up scroll region and restore screen
    this.setupScrollRegion();
    process.stdout.write(this.sessions[index].getScreenState());
    this.renderFooter();
    this.startFooterRefresh();
  }

  private handleAction(action: HotkeyAction): void {
    switch (action.type) {
      case "dashboard":
        this.setMode("dashboard");
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

      case "passthrough":
        this.activeSession?.write(action.data);
        break;
    }
  }

  private handleDashboardKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;
    const hasWorktrees = this.worktreeNavOrder.length > 1;

    if (this.dashboardBusyState) {
      return;
    }

    if (this.dashboardErrorState) {
      if (key === "escape" || key === "enter" || key === "return") {
        this.dismissDashboardError();
      }
      return;
    }

    // Digits 1-9: always focus session directly (shortcut)
    if (key >= "1" && key <= "9") {
      const index = parseInt(key) - 1;
      if (index < this.sessions.length) {
        this.focusSession(index);
      }
      return;
    }

    // Keys that work at any level
    switch (key) {
      case "c":
        this.showToolPicker();
        return;
      case "q":
        this.resolveRun?.(0);
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
      case "a":
        this.showMetaDashboard();
        return;
      case "x": {
        // At worktree level, [x] removes the focused worktree
        if (hasWorktrees && this.dashboardLevel === "worktrees" && this.focusedWorktreePath) {
          const wtName = this.focusedWorktreePath.split("/").pop() ?? this.focusedWorktreePath;
          this.worktreeRemoveConfirm = { path: this.focusedWorktreePath, name: wtName };
          this.renderWorktreeRemoveConfirm();
          return;
        }

        const allDs = this.getDashboardSessions();
        const selId =
          this.dashboardLevel === "sessions" && this.dashboardWorktreeSessions.length > 0
            ? this.dashboardWorktreeSessions[this.dashboardSessionIndex]?.id
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
          this.dashboardLevel === "sessions" && this.dashboardWorktreeSessions.length > 0
            ? this.dashboardWorktreeSessions[this.dashboardSessionIndex]?.id
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
    if (this.dashboardLevel === "worktrees") {
      switch (key) {
        case "down":
        case "j":
        case "n": {
          const curIdx = this.worktreeNavOrder.indexOf(this.focusedWorktreePath);
          this.focusedWorktreePath = this.worktreeNavOrder[(curIdx + 1) % this.worktreeNavOrder.length];
          this.renderDashboard();
          break;
        }
        case "up":
        case "k":
        case "p": {
          const curIdx = this.worktreeNavOrder.indexOf(this.focusedWorktreePath);
          this.focusedWorktreePath =
            this.worktreeNavOrder[(curIdx - 1 + this.worktreeNavOrder.length) % this.worktreeNavOrder.length];
          this.renderDashboard();
          break;
        }
        case "enter":
        case "right":
        case "l":
          // Step into worktree to navigate its sessions
          this.updateWorktreeSessions();
          if (this.dashboardWorktreeSessions.length > 0) {
            this.dashboardLevel = "sessions";
            this.dashboardSessionIndex = 0;
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
          if (this.dashboardWorktreeSessions.length > 1) {
            this.dashboardSessionIndex = (this.dashboardSessionIndex + 1) % this.dashboardWorktreeSessions.length;
            this.renderDashboard();
          }
          break;
        case "up":
        case "k":
        case "p":
          if (this.dashboardWorktreeSessions.length > 1) {
            this.dashboardSessionIndex =
              (this.dashboardSessionIndex - 1 + this.dashboardWorktreeSessions.length) %
              this.dashboardWorktreeSessions.length;
            this.renderDashboard();
          }
          break;
        case "enter": {
          const dashEntry = this.dashboardWorktreeSessions[this.dashboardSessionIndex];
          if (!dashEntry) break;
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
          this.dashboardLevel = "worktrees";
          this.renderDashboard();
          break;
      }
    }
  }

  /** Get sessions belonging to the focused worktree (includes local, remote, offline) */
  private updateWorktreeSessions(): void {
    const allDash = this.getDashboardSessions();
    this.dashboardWorktreeSessions = allDash.filter((s) => {
      return (s.worktreePath ?? undefined) === this.focusedWorktreePath;
    });
  }

  private showToolPicker(): void {
    const config = loadConfig();
    const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);

    if (tools.length === 1) {
      const [key, tool] = tools[0];
      if (!isToolAvailable(tool.command)) {
        // Show all tools anyway so user sees what's supported
      } else {
        // Only one available tool — skip picker, spawn directly
        const wtPath = this.mode === "dashboard" ? this.focusedWorktreePath : undefined;
        this.createSession(tool.command, tool.args, tool.preambleFlag, key, undefined, tool.sessionIdFlag, wtPath);
        return;
      }
    }

    this.pickerActive = true;

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const lines = ["Select tool:"];
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

  private handleToolPickerKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    this.pickerActive = false;

    if (key === "escape") {
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
        const wtPath = this.mode === "dashboard" ? this.focusedWorktreePath : undefined;
        this.createSession(tool.command, tool.args, tool.preambleFlag, key, undefined, tool.sessionIdFlag, wtPath);
        return;
      }
    }

    // Invalid key — redraw current view
    if (this.mode === "dashboard") {
      this.renderDashboard();
    } else {
      this.focusSession(this.activeIndex);
    }
  }

  private renderDashboard(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    let mainRepoPath: string | undefined;
    let mainCheckoutInfo = { name: "Main Checkout", branch: "" };
    try {
      mainRepoPath = findMainRepo();
    } catch {}

    const dashSessions: DashboardSession[] = this.sessions.map((s, i) => {
      const rawWtPath = this.sessionWorktreePaths.get(s.id);
      const wtPath = rawWtPath && mainRepoPath && rawWtPath === mainRepoPath ? undefined : rawWtPath;
      return {
        index: i,
        id: s.id,
        command: s.command,
        status: s.status,
        active: i === this.activeIndex,
        worktreePath: wtPath,
        isServer: this.serverSessionIds.has(s.id),
      };
    });

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
    this.worktreeNavOrder = [undefined, ...worktreeGroups.map((wt) => wt.path)];
    // Ensure focusedWorktreePath is valid
    if (!this.worktreeNavOrder.includes(this.focusedWorktreePath)) {
      this.focusedWorktreePath = undefined;
    }

    // Determine selected session for cursor (set after all sessions are merged below)
    let selectedSession: string | undefined;

    // Merge remote sessions (from other aimux instances) into dashSessions
    try {
      const remote = getRemoteInstances(this.instanceId, process.cwd());
      for (const inst of remote) {
        for (const rs of inst.sessions) {
          // Skip if we already own a session with same backendSessionId
          const alreadyOwned = dashSessions.some((ds) => ds.id === rs.id);
          if (alreadyOwned) continue;
          dashSessions.push({
            index: dashSessions.length,
            id: rs.id,
            command: rs.tool,
            status: "running" as const,
            active: false,
            worktreePath:
              rs.worktreePath && mainRepoPath && rs.worktreePath === mainRepoPath ? undefined : rs.worktreePath,
            remoteInstancePid: inst.pid,
            remoteInstanceId: inst.instanceId,
            remoteBackendSessionId: rs.backendSessionId,
          });
        }
      }
    } catch {
      // Registry read failed — skip remote display
    }

    // Add offline sessions from previous runs
    for (const os of this.offlineSessions) {
      const alreadyShown = dashSessions.some(
        (ds) => ds.id === os.id || (os.backendSessionId && ds.remoteBackendSessionId === os.backendSessionId),
      );
      if (alreadyShown) continue;
      dashSessions.push({
        index: dashSessions.length,
        id: os.id,
        command: os.command,
        status: "offline" as const,
        active: false,
        worktreePath: os.worktreePath && mainRepoPath && os.worktreePath === mainRepoPath ? undefined : os.worktreePath,
      });
    }

    // Determine selected session cursor
    if (hasWorktrees && this.dashboardLevel === "sessions" && this.dashboardWorktreeSessions.length > 0) {
      selectedSession = this.dashboardWorktreeSessions[this.dashboardSessionIndex]?.id;
    } else if (!hasWorktrees && dashSessions.length > 0) {
      // Flat mode — use activeIndex across all dash sessions
      selectedSession = dashSessions[this.activeIndex]?.id;
    }

    this.dashboard.update(
      dashSessions,
      worktreeGroups,
      this.focusedWorktreePath,
      hasWorktrees ? this.dashboardLevel : "sessions",
      selectedSession,
      this.serverClient?.connected ?? false,
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
      this.worktreeNavOrder = [undefined, ...newWorktrees.map((wt) => wt.path)];
      if (job.oldIdx >= 0 && job.oldIdx < this.worktreeNavOrder.length) {
        this.focusedWorktreePath = this.worktreeNavOrder[job.oldIdx];
      } else if (this.worktreeNavOrder.length > 1) {
        this.focusedWorktreePath = this.worktreeNavOrder[this.worktreeNavOrder.length - 1];
      } else {
        this.focusedWorktreePath = undefined;
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
        const oldIdx = this.worktreeNavOrder.indexOf(confirm.path);
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
    const graveyardPath = getGraveyardPath();
    try {
      this.graveyardEntries = JSON.parse(readFileSync(graveyardPath, "utf-8")) as SessionState[];
    } catch {
      this.graveyardEntries = [];
    }
    this.graveyardActive = true;
    this.renderGraveyard();
  }

  private renderGraveyard(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const lines = ["Graveyard:", ""];
    if (this.graveyardEntries.length === 0) {
      lines.push("  (empty)");
    } else {
      for (let i = 0; i < this.graveyardEntries.length; i++) {
        const s = this.graveyardEntries[i];
        const bsid = s.backendSessionId ? ` (${s.backendSessionId.slice(0, 8)}…)` : "";
        const identity = s.label ? ` — ${s.label}` : "";
        const headline = s.headline ? ` · ${s.headline}` : "";
        lines.push(`  [${i + 1}] ${s.command}:${s.id}${bsid}${identity}${headline}`);
      }
    }
    lines.push("");
    lines.push("  [1-9] resurrect  [Esc] back");

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

  private handleGraveyardKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    if (key === "escape") {
      this.graveyardActive = false;
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }

    if (key >= "1" && key <= "9") {
      const idx = parseInt(key) - 1;
      if (idx < this.graveyardEntries.length) {
        const entry = this.graveyardEntries[idx];
        // Resurrect: move from graveyard to offline
        this.graveyardEntries.splice(idx, 1);
        writeFileSync(getGraveyardPath(), JSON.stringify(this.graveyardEntries, null, 2) + "\n");

        // Add to offline sessions and state.json
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

        if (this.graveyardEntries.length === 0) {
          this.graveyardActive = false;
          if (this.mode === "dashboard") {
            this.renderDashboard();
          } else {
            this.focusSession(this.activeIndex);
          }
        } else {
          this.renderGraveyard();
        }
      }
      return;
    }
  }

  // --- Quick Switcher (^A s) ---

  /** Get sessions in MRU order (most recently used first), only running/alive sessions */
  private getSwitcherList(): PtySession[] {
    const alive = this.getScopedSessionEntries()
      .map(({ session }) => session)
      .filter((s) => !s.exited);
    // Build MRU-ordered list: known MRU order first, then any remaining
    const ordered: PtySession[] = [];
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
    // Restore current screen
    if (this.mode === "dashboard") {
      this.renderDashboard();
    } else {
      this.setupScrollRegion();
      if (this.sessions[this.activeIndex]) {
        process.stdout.write(this.sessions[this.activeIndex].getScreenState());
      }
      this.renderFooter();
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

  // --- Meta Dashboard (all projects) ---

  private showMetaDashboard(): void {
    this.metaDashboardActive = true;
    this.renderMetaDashboard();
  }

  private renderMetaDashboard(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const projects = scanAllProjects();

    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

    const center = (text: string) => {
      const pad = Math.max(0, Math.floor((cols - strip(text).length) / 2));
      return " ".repeat(pad) + text;
    };

    const lines: string[] = [];

    // Title
    lines.push("");
    lines.push(center("\x1b[1maimux\x1b[0m — all projects"));
    lines.push(center("─".repeat(Math.min(50, cols - 4))));
    lines.push("");

    if (projects.length === 0) {
      lines.push(center("No aimux projects found."));
    } else {
      for (const project of projects) {
        const running = project.sessions.filter((s) => s.status !== "offline").length;
        const offline = project.sessions.filter((s) => s.status === "offline").length;
        const counts: string[] = [];
        if (running > 0) counts.push(`${running} running`);
        if (offline > 0) counts.push(`${offline} offline`);
        const countStr = counts.length > 0 ? ` (${counts.join(", ")})` : "";

        lines.push(`  \x1b[1m${project.name}\x1b[0m${countStr}`);

        for (const session of project.sessions) {
          const icon =
            session.status === "running"
              ? "\x1b[33m●\x1b[0m"
              : session.status === "idle"
                ? "\x1b[32m●\x1b[0m"
                : session.status === "waiting"
                  ? "\x1b[36m◉\x1b[0m"
                  : "\x1b[2m○\x1b[0m";

          const identity = session.label ?? session.tool;
          const headline = session.headline ? ` \x1b[2m· ${session.headline.slice(0, 40)}\x1b[0m` : "";
          const owner = session.isServer
            ? " \x1b[2;32m[server]\x1b[0m"
            : session.ownerPid
              ? ` \x1b[2m[PID ${session.ownerPid}]\x1b[0m`
              : "";

          lines.push(`    ${icon} ${identity}${headline}${owner}`);
        }
        lines.push("");
      }
    }

    // Fill remaining space
    const helpLine = " [a] back  [q] quit ";
    const usedLines = lines.length + 2;
    const remaining = Math.max(0, rows - usedLines);
    for (let i = 0; i < remaining; i++) {
      lines.push("");
    }

    lines.push(center("─".repeat(Math.min(cols - 4, strip(helpLine).length + 4))));
    lines.push(center(helpLine));

    // Full screen render (same as dashboard)
    const screen = "\x1b[2J\x1b[H" + lines.join("\r\n");
    process.stdout.write(screen);
  }

  private handleMetaDashboardKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    if (key === "escape" || key === "a") {
      this.metaDashboardActive = false;
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }
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

  private waitForSessionExit(session: PtySession, timeoutMs = 15_000): Promise<void> {
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

  private async stopSessionToOfflineWithFeedback(session: PtySession): Promise<void> {
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

  private async migrateSessionWithFeedback(session: PtySession, targetPath: string, targetName: string): Promise<void> {
    const label = this.getSessionLabel(session.id) ?? session.command;
    await this.runDashboardOperation(
      `Migrating "${label}"`,
      [`  From: ${this.sessionWorktreePaths.get(session.id) ?? "(main)"}`, `  To: ${targetName}`],
      async () => {
        this.migrateAgent(session.id, targetPath);
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
    // Normalize worktreePath: if it equals the main repo, treat as undefined (not a worktree)
    let mainRepoPath: string | undefined;
    try {
      mainRepoPath = findMainRepo();
    } catch {}
    const normalizeWtPath = (p?: string) => (p && mainRepoPath && p === mainRepoPath ? undefined : p);

    const dashSessions: DashboardSession[] = this.sessions.map((s, i) => {
      const wtPath = normalizeWtPath(this.sessionWorktreePaths.get(s.id));
      const label = this.getSessionLabel(s.id);
      const headline = this.deriveHeadline(s.id);
      return {
        index: i,
        id: s.id,
        command: s.command,
        status: s.status,
        active: i === this.activeIndex,
        worktreePath: wtPath,
        label,
        headline,
        taskDescription: this.taskDispatcher?.getSessionTask(s.id),
        role: this.sessionRoles.get(s.id),
      };
    });
    try {
      const remote = getRemoteInstances(this.instanceId, process.cwd());
      for (const inst of remote) {
        const isServer = inst.instanceId.startsWith("server-");
        for (const rs of inst.sessions) {
          if (dashSessions.some((ds) => ds.id === rs.id)) continue;
          const remoteLabel = this.getSessionLabel(rs.id);
          const remoteHeadline = this.readStatusHeadline(rs.id);
          dashSessions.push({
            index: dashSessions.length,
            id: rs.id,
            command: rs.tool,
            status: "running",
            active: false,
            worktreePath: normalizeWtPath(rs.worktreePath),
            remoteInstancePid: isServer ? undefined : inst.pid,
            remoteInstanceId: inst.instanceId,
            remoteBackendSessionId: rs.backendSessionId,
            label: remoteLabel,
            headline: remoteHeadline,
            isServer,
          });
        }
      }
    } catch {}

    // Add offline sessions
    for (const os of this.offlineSessions) {
      const alreadyShown = dashSessions.some(
        (ds) => ds.id === os.id || (os.backendSessionId && ds.remoteBackendSessionId === os.backendSessionId),
      );
      if (alreadyShown) continue;
      // Resolve worktree name/branch for display
      const osWtPath = normalizeWtPath(os.worktreePath);
      let worktreeName: string | undefined;
      let worktreeBranch: string | undefined;
      if (osWtPath) {
        try {
          const allWt = listAllWorktrees(osWtPath);
          const wt = allWt.find((w) => w.path === osWtPath);
          worktreeName = wt?.name;
          worktreeBranch = wt?.branch;
        } catch {}
        if (!worktreeName) {
          worktreeName = osWtPath.split("/").pop();
        }
      }
      dashSessions.push({
        index: dashSessions.length,
        id: os.id,
        command: os.command,
        status: "offline" as const,
        active: false,
        worktreePath: osWtPath,
        worktreeName,
        worktreeBranch,
        remoteBackendSessionId: os.backendSessionId,
        label: os.label,
        headline: os.headline,
      });
    }

    return dashSessions;
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
    const claimed = await claimSession(target.id, target.fromInstanceId, process.cwd());
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

    // Build resume args with the backend session ID
    const resumeArgs = toolCfg.resumeArgs.map((a: string) => a.replace("{sessionId}", target.backendSessionId));

    debug(
      `taking over session ${target.id} (backend=${target.backendSessionId}) from instance ${target.fromInstanceId}`,
      "instance",
    );
    this.createSession(
      target.tool,
      resumeArgs,
      toolCfg.preambleFlag,
      toolConfigKey,
      undefined,
      undefined,
      claimed.worktreePath,
    );

    if (this.mode === "dashboard") {
      this.renderDashboard();
    } else {
      this.focusSession(this.sessions.length - 1);
    }
  }

  private setMode(mode: MuxMode): void {
    const prev = this.mode;
    this.mode = mode;

    if (mode === "dashboard" && prev !== "dashboard") {
      // Stop footer, reset scroll region, enter alternate screen
      this.stopFooterRefresh();
      this.resetScrollRegion();
      process.stdout.write("\x1b[?1049h");
      this.renderDashboard();
    } else if (mode === "focused" && prev === "dashboard") {
      // Leave alternate screen buffer
      process.stdout.write("\x1b[?1049l");
    }
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

  /** Write active sessions to .aimux/sessions.json so agents can discover each other */
  /**
   * Capture backend session ID by watching a directory for new files.
   * Config-driven: uses sessionCapture.dir, .pattern, .delayMs from ToolConfig.
   */
  private captureSessionId(session: PtySession, capture: import("./config.js").SessionCaptureConfig): void {
    const now = new Date();
    const dir = capture.dir
      .replace("{home}", process.env.HOME ?? "")
      .replace("{yyyy}", String(now.getFullYear()))
      .replace("{mm}", String(now.getMonth() + 1).padStart(2, "0"))
      .replace("{dd}", String(now.getDate()).padStart(2, "0"));
    const regex = new RegExp(capture.pattern);

    // Snapshot current files
    let beforeFiles: string[] = [];
    try {
      beforeFiles = readdirSync(dir);
    } catch {}

    const checkForNew = () => {
      try {
        const afterFiles = readdirSync(dir);
        const newFiles = afterFiles.filter((f) => !beforeFiles.includes(f));
        for (const file of newFiles) {
          const match = file.match(regex);
          if (match) {
            session.backendSessionId = match[1];
            debug(`captured backendSessionId: ${match[1]}`, "session");
            return;
          }
        }
      } catch {}
    };

    // Try a few times with increasing delays
    const delay = capture.delayMs;
    setTimeout(checkForNew, delay);
    setTimeout(checkForNew, delay * 2.5);
    setTimeout(checkForNew, delay * 5);
  }

  private writeSessionsFile(): void {
    const dir = getLocalAimuxDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Local sessions
    const data: Array<Record<string, unknown>> = this.sessions.map((s) => ({
      id: s.id,
      tool: s.command,
      status: s.status,
      backendSessionId: s.backendSessionId,
      worktreePath: this.sessionWorktreePaths.get(s.id),
    }));

    // Include remote sessions so agents can discover cross-instance agents
    try {
      const remote = getRemoteInstances(this.instanceId, process.cwd());
      for (const inst of remote) {
        for (const rs of inst.sessions) {
          if (data.some((d) => d.id === rs.id)) continue;
          data.push({
            id: rs.id,
            tool: rs.tool,
            status: "running",
            backendSessionId: rs.backendSessionId,
            worktreePath: rs.worktreePath,
            instance: `PID ${inst.pid}`,
          });
        }
      }
    } catch {}

    writeFileSync(`${dir}/sessions.json`, JSON.stringify(data, null, 2) + "\n");
  }

  /** Write statusline state for Claude Code's statusline script to read */
  private writeStatuslineFile(): void {
    try {
      const dir = getProjectStateDir();
      const data = {
        project: basename(process.cwd()),
        sessions: this.sessions.map((s, i) => ({
          id: s.id,
          tool: s.command,
          label: this.getSessionLabel(s.id),
          headline: this.deriveHeadline(s.id),
          status: s.status,
          role: this.sessionRoles.get(s.id),
          active: i === this.activeIndex,
        })),
        tasks: this.taskDispatcher?.getTaskCounts() ?? { pending: 0, assigned: 0 },
        flash: this.footerFlash,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(join(dir, "statusline.json"), JSON.stringify(data) + "\n");
    } catch {}
  }

  /** Remove sessions file on exit */
  private removeSessionsFile(): void {
    try {
      unlinkSync(`${getLocalAimuxDir()}/sessions.json`);
    } catch {}
  }

  /** Terminal rows available for the tool (total minus footer) */
  private get toolRows(): number {
    const rows = process.stdout.rows ?? 24;
    return this.mode === "focused" ? rows - this.footerHeight : rows;
  }

  private get footerHeight(): number {
    return this.footerPlugins.enabledCount > 0 ? 2 : 1;
  }

  /** Set scroll region to exclude footer row */
  private setupScrollRegion(): void {
    const rows = process.stdout.rows ?? 24;
    const toolRows = rows - this.footerHeight;
    // Set scroll region to top portion, leaving bottom row for footer
    process.stdout.write(`\x1b[1;${toolRows}r`);
    // Move cursor back into scroll region
    process.stdout.write(`\x1b[${toolRows};1H`);
  }

  /** Reset scroll region to full terminal */
  private resetScrollRegion(): void {
    process.stdout.write("\x1b[r");
  }

  /** Render the status footer in the reserved bottom row */
  private renderFooter(): void {
    if (this.mode !== "focused") return;

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const stripTerminalCodes = (s: string) =>
      s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b]8;;.*?(?:\x07|\x1b\\)/g, "");
    const ellipsizeEnd = (s: string, max: number) => {
      if (max <= 0) return "";
      if (s.length <= max) return s;
      if (max <= 1) return "…";
      return `${s.slice(0, max - 1)}…`;
    };
    const formatHyperlink = (text: string, href?: string) => (href ? `\x1b]8;;${href}\x07${text}\x1b]8;;\x07` : text);
    const fitPlainText = (text: string) => ellipsizeEnd(text, cols);
    const drawRow = (row: number, content: string) => `\x1b[${row};1H\x1b[2K${content}`;

    const STATUS_ICONS: Record<string, string> = {
      running: "●",
      idle: "●",
      waiting: "◉",
      exited: "○",
    };

    // Build session indicators
    const parts: string[] = [];
    const scopedSessions = this.getScopedSessionEntries();
    for (let i = 0; i < scopedSessions.length; i++) {
      const { session: s, index } = scopedSessions[i];
      const icon = STATUS_ICONS[s.status] ?? "?";
      const name = this.getSessionLabel(s.id) ?? s.command;
      const activePrefix = index === this.activeIndex ? "*" : "";
      parts.push(`${activePrefix}${icon} ${i + 1}:${name}`);
    }

    const activeSession = this.sessions[this.activeIndex];
    if (activeSession) {
      const headline = this.deriveHeadline(activeSession.id);
      if (headline) {
        parts.push(headline);
      }
    }

    const counts = this.taskDispatcher?.getTaskCounts();
    if (counts && (counts.pending > 0 || counts.assigned > 0)) {
      parts.push(`[T:${counts.pending}p/${counts.assigned}a]`);
    }
    if (this.footerFlash) {
      parts.push(stripTerminalCodes(this.footerFlash));
    }

    const footerHeight = this.footerHeight;
    const tabsRow = fitPlainText(` ${parts.join("  ")}`.replace(/\s+/g, " ").trimStart());
    const pluginParts = this.footerPlugins.render(this.getActiveSessionFooterContext());
    const helpText = "";
    const renderedPluginParts: string[] = [];
    let usedPluginWidth = helpText.length;
    for (const plugin of pluginParts) {
      const separatorWidth = renderedPluginParts.length > 0 ? 2 : 0;
      const remaining = cols - usedPluginWidth - separatorWidth;
      if (remaining <= 1) break;
      const fitted = ellipsizeEnd(plugin.text, remaining);
      if (!fitted) break;
      renderedPluginParts.push(formatHyperlink(fitted, plugin.href));
      usedPluginWidth += separatorWidth + fitted.length;
    }
    const pluginRow = renderedPluginParts.join("  ");

    // Save cursor, move to footer row, draw, restore cursor
    if (footerHeight === 1) {
      process.stdout.write(`\x1b7${drawRow(rows, tabsRow)}\x1b8`);
      return;
    }
    process.stdout.write(`\x1b7${drawRow(rows - 1, tabsRow)}${drawRow(rows, pluginRow)}\x1b8`);
  }

  private getActiveSessionFooterContext(): FooterPluginContext {
    const activeSession = this.sessions[this.activeIndex];
    if (!activeSession) {
      return {
        projectCwd: process.cwd(),
        activeSessionPath: process.cwd(),
        locationLabel: process.cwd().replace(homedir(), "~"),
        isMainCheckout: true,
      };
    }

    const worktreePath = this.sessionWorktreePaths.get(activeSession.id);
    let mainRepoPath: string | undefined;
    try {
      mainRepoPath = findMainRepo();
    } catch {}

    if (!worktreePath || (mainRepoPath && worktreePath === mainRepoPath)) {
      try {
        const worktrees = listAllWorktrees();
        const mainWorktree =
          (mainRepoPath ? worktrees.find((wt) => wt.path === mainRepoPath) : worktrees[0]) ?? worktrees[0];
        if (mainWorktree) {
          return {
            projectCwd: process.cwd(),
            activeSessionId: activeSession.id,
            activeSessionPath: mainWorktree.path,
            locationLabel: `Main Checkout · ${mainWorktree.branch}`,
            branch: mainWorktree.branch,
            worktreeName: mainWorktree.name,
            isMainCheckout: true,
          };
        }
      } catch {}
      return {
        projectCwd: process.cwd(),
        activeSessionId: activeSession.id,
        activeSessionPath: mainRepoPath ?? process.cwd(),
        locationLabel: `Main Checkout · ${process.cwd().replace(homedir(), "~")}`,
        isMainCheckout: true,
      };
    }

    try {
      const worktrees = listAllWorktrees(worktreePath);
      const current = worktrees.find((wt) => wt.path === worktreePath);
      if (current) {
        return {
          projectCwd: process.cwd(),
          activeSessionId: activeSession.id,
          activeSessionPath: worktreePath,
          locationLabel: `Worktree · ${current.name} · ${current.branch}`,
          branch: current.branch,
          worktreeName: current.name,
          isMainCheckout: false,
        };
      }
    } catch {}

    return {
      projectCwd: process.cwd(),
      activeSessionId: activeSession.id,
      activeSessionPath: worktreePath,
      locationLabel: `Worktree · ${worktreePath.replace(homedir(), "~")}`,
      isMainCheckout: false,
    };
  }

  /** Track previous statuses for notification on transition */
  private prevStatuses = new Map<string, string>();
  /** Flash message shown temporarily in footer, cleared after a few renders */
  private footerFlash: string | null = null;
  private footerFlashTicks = 0;

  private startFooterRefresh(): void {
    if (this.footerInterval) return;
    this.renderFooter();
    // Refresh every 1s to pick up status changes, dispatch tasks, and check notifications
    this.footerInterval = setInterval(() => {
      if (this.mode === "focused") this.renderFooter();
      this.taskDispatcher?.tick(this.sessions.map((s) => s.id));
      this.writeStatuslineFile();

      // Drain task events for flash notifications
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
        this.footerFlashTicks = 3; // show for ~6s (3 ticks × 2s)
      }
      if (this.footerFlashTicks > 0) this.footerFlashTicks--;
      if (this.footerFlashTicks === 0) this.footerFlash = null;

      // Check for status transitions that warrant notifications
      for (const session of this.sessions) {
        const prev = this.prevStatuses.get(session.id);
        const curr = session.status;
        if (prev && prev !== curr) {
          if (curr === "idle" && prev === "running") {
            notifyPrompt(session.id);
          }
        }
        this.prevStatuses.set(session.id, curr);
      }
    }, 1000);
  }

  private stopFooterRefresh(): void {
    if (this.footerInterval) {
      clearInterval(this.footerInterval);
      this.footerInterval = null;
    }
  }

  /** Load offline sessions from state.json, excluding any that are owned by live instances */
  private loadOfflineSessions(): void {
    const state = Multiplexer.loadState();
    if (!state || state.sessions.length === 0) return;

    // Get all session IDs owned by live instances (including ourselves)
    const ownedIds = new Set<string>();
    for (const s of this.sessions) ownedIds.add(s.id);
    try {
      const remote = getRemoteInstances(this.instanceId, process.cwd());
      for (const inst of remote) {
        for (const rs of inst.sessions) ownedIds.add(rs.id);
      }
    } catch {}

    // Also exclude by backendSessionId to catch resumed sessions with new IDs
    const ownedBackendIds = new Set<string>();
    for (const s of this.sessions) {
      const bsid = s.backendSessionId;
      if (bsid) ownedBackendIds.add(bsid);
    }

    this.offlineSessions = state.sessions.filter((s) => {
      if (ownedIds.has(s.id)) return false;
      if (s.backendSessionId && ownedBackendIds.has(s.backendSessionId)) return false;
      return true;
    });

    if (this.offlineSessions.length > 0) {
      debug(`loaded ${this.offlineSessions.length} offline session(s) from state.json`, "session");
    }
  }

  /** Remove an offline session and move it to state-trash.json */
  /** Stop a running session and move it to offline (first [x]) */
  private stopSessionToOffline(session: PtySession): void {
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
    if (hasWorktrees && this.dashboardLevel === "sessions") {
      this.updateWorktreeSessions();
      if (this.dashboardWorktreeSessions.length === 0) {
        // No more agents in this worktree — step back to worktree level
        this.dashboardLevel = "worktrees";
      } else if (this.dashboardSessionIndex >= this.dashboardWorktreeSessions.length) {
        this.dashboardSessionIndex = this.dashboardWorktreeSessions.length - 1;
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

    let args: string[];
    if (session.backendSessionId && toolCfg.resumeArgs) {
      args = toolCfg.resumeArgs.map((a: string) => a.replace("{sessionId}", session.backendSessionId!));
    } else {
      args = [...(toolCfg.resumeFallback ?? toolCfg.args)];
    }

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
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      const sessions = this.getInstanceSessionRefs();
      updateHeartbeat(this.instanceId, sessions, process.cwd())
        .then((previousIds) => {
          // Only detect claims if we got a valid response (previousIds is non-empty
          // OR we have no sessions to confirm). If previousIds is empty but we have
          // confirmed sessions, our registry entry may have been pruned/lost — skip
          // claim detection this cycle to avoid false positives.
          if (previousIds.length > 0 || this.confirmedRegistered.size === 0) {
            const previousSet = new Set(previousIds);
            for (const id of this.confirmedRegistered) {
              if (!previousSet.has(id)) {
                debug(`session ${id} claimed: was in confirmedRegistered but not in previousIds`, "instance");
                this.handleSessionClaimed(id);
                this.confirmedRegistered.delete(id);
              }
            }
          } else if (this.confirmedRegistered.size > 0) {
            debug(
              `skipping claim detection: previousIds empty but ${this.confirmedRegistered.size} confirmed sessions (registry entry may have been pruned)`,
              "instance",
            );
          }
          // Mark all sessions we just wrote as confirmed
          for (const s of sessions) {
            this.confirmedRegistered.add(s.id);
          }
        })
        .catch(() => {});
      // Refresh offline sessions from state.json (picks up cross-instance graveyard/kill)
      this.loadOfflineSessions();
      // Refresh dashboard to pick up remote instance changes (skip if overlay is active)
      if (this.mode === "dashboard" && !this.metaDashboardActive && !this.graveyardActive) {
        this.renderDashboard();
      }
    }, 5000);
  }

  /**
   * Handle a session that was claimed (taken over) by another aimux instance.
   * Kill the local PTY and switch to dashboard if it was the focused session.
   */
  private handleSessionClaimed(sessionId: string): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const wasFocused = this.mode === "focused" && this.sessions[this.activeIndex] === session;
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
      this.sessionStartTimes.delete(sessionId);
    }

    // Adjust active index
    if (this.activeIndex >= this.sessions.length) {
      this.activeIndex = Math.max(0, this.sessions.length - 1);
    }

    // If the claimed session was focused, switch to dashboard
    if (wasFocused) {
      this.setMode("dashboard");
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
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

  private enterRawMode(): void {
    if (process.stdin.isTTY) {
      this.rawModeWas = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
  }

  private exitRawMode(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(this.rawModeWas ?? false);
      process.stdin.pause();
    }
  }

  /** Get the shared state.json path (in main repo for cross-worktree visibility). */
  private static getSharedStatePath(): string {
    return getStatePath();
  }

  /** Save session state to main repo's .aimux/state.json, merging with existing state. */
  private saveState(): void {
    const localSessions = this.sessions.filter((s) => !this.serverSessionIds.has(s.id));
    const liveSessions = localSessions.map((s) => ({
      id: s.id,
      tool: s.command,
      toolConfigKey: this.sessionToolKeys.get(s.id) ?? s.command,
      command: s.command,
      args: this.sessionOriginalArgs.get(s.id) ?? [],
      backendSessionId: s.backendSessionId,
      worktreePath: this.sessionWorktreePaths.get(s.id),
      label: this.getSessionLabel(s.id),
      headline: this.deriveHeadline(s.id),
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
    this.taskDispatcher = null;
    unregisterInstance(this.instanceId, process.cwd()).catch(() => {});
    this.saveState();
    this.stopFooterRefresh();
    this.contextWatcher.stop();
    this.resetScrollRegion();
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
    this.exitRawMode();
    // Ensure we leave alternate screen and restore cursor
    process.stdout.write("\x1b[?1049l\x1b[?25h");
  }

  cleanup(): void {
    for (const session of this.sessions) {
      // Don't kill server-owned sessions — they persist after TUI exits
      if (this.serverSessionIds.has(session.id)) continue;
      session.destroy();
    }
    // Disconnect from server (sessions keep running)
    if (this.serverClient) {
      this.serverClient.disconnect();
      this.serverClient = null;
    }
    this.teardown();
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
