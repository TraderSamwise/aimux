import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync, readdirSync, cpSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { PtySession, type PtySessionOptions } from "./pty-session.js";
import { HotkeyHandler, type HotkeyAction } from "./hotkeys.js";
import { Dashboard, type DashboardSession, type WorktreeGroup } from "./dashboard.js";
import { captureGitContext, ContextWatcher, buildContextPreamble } from "./context/context-bridge.js";
import { readHistory } from "./context/history.js";
import { parseKeys } from "./key-parser.js";
import { loadConfig, getAimuxDir, initProject, type ToolConfig } from "./config.js";
import { debug, debugPreamble, closeDebug } from "./debug.js";
import { findMainRepo, getRepoName, listWorktrees as listAllWorktrees, loadRegistry, createWorktree, removeWorktree, cleanWorktrees } from "./worktree.js";
import { notifyPrompt, notifyComplete } from "./notify.js";

export type MuxMode = "focused" | "dashboard";

export interface SessionState {
  id: string;
  tool: string;
  toolConfigKey: string;
  command: string;
  args: string[];
  worktreePath?: string;
}

export interface SavedState {
  savedAt: string;
  cwd: string;
  sessions: SessionState[];
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
  private defaultCommand: string = "claude";
  private defaultArgs: string[] = [];
  private startedInDashboard = false;
  private pickerActive = false;
  private worktreeInputActive = false;
  private worktreeInputBuffer = "";
  private worktreeListActive = false;
  private migratePickerActive = false;
  private migratePickerWorktrees: Array<{ name: string; path: string }> = [];
  /** The focused worktree path on the dashboard (undefined = main repo) */
  private focusedWorktreePath: string | undefined = undefined;
  /** Ordered list of worktree paths for navigation (undefined = main repo) */
  private worktreeNavOrder: Array<string | undefined> = [];
  /** Dashboard navigation level: worktrees (top) or sessions (inside a worktree) */
  private dashboardLevel: "worktrees" | "sessions" = "sessions";
  /** Index within sessions of the focused worktree */
  private dashboardSessionIndex = 0;
  /** Sessions in the currently focused worktree (for session-level nav) */
  private dashboardWorktreeSessions: PtySession[] = [];
  private footerInterval: ReturnType<typeof setInterval> | null = null;
  private contextWatcher = new ContextWatcher();
  /** Maps session ID → toolConfigKey for state saving */
  private sessionToolKeys = new Map<string, string>();
  /** Maps session ID → original args (before preamble injection) */
  private sessionOriginalArgs = new Map<string, string[]>();
  /** Maps session ID → worktree path (if session runs in a worktree) */
  private sessionWorktreePaths = new Map<string, string>();
  private static readonly FOOTER_HEIGHT = 1;

  constructor() {
    this.hotkeys = new HotkeyHandler((action) => this.handleAction(action));
    this.dashboard = new Dashboard();
  }

  get activeSession(): PtySession | null {
    return this.sessions[this.activeIndex] ?? null;
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  async run(opts: Omit<PtySessionOptions, "cols" | "rows">): Promise<number> {
    initProject();
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
    this.createSession(opts.command, opts.args, toolConfig?.preambleFlag, toolConfigKey, undefined, toolConfig?.sessionIdFlag);

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
    const state = Multiplexer.loadState();
    if (!state || state.sessions.length === 0) {
      console.error("No saved session state found (or state is stale). Starting fresh.");
      return this.runDashboard();
    }

    const config = loadConfig();
    const sessionsToResume = toolFilter
      ? state.sessions.filter(s => s.tool === toolFilter || s.toolConfigKey === toolFilter)
      : state.sessions;

    if (sessionsToResume.length === 0) {
      console.error(`No saved sessions found for tool "${toolFilter}". Starting fresh.`);
      return this.runDashboard();
    }

    // Spawn each session with resumeArgs, substituting backend session ID
    for (const saved of sessionsToResume) {
      const toolCfg = config.tools[saved.toolConfigKey];
      if (!toolCfg) continue;

      const bsid = (saved as any).backendSessionId as string | undefined;
      let resumeArgs: string[];
      if (bsid) {
        // Substitute backend session ID into resume args
        resumeArgs = (toolCfg.resumeArgs ?? []).map(
          (a: string) => a.replace("{sessionId}", bsid)
        );
      } else {
        // No backend session ID — fall back to --continue/--last
        if (saved.command === "claude") {
          resumeArgs = ["--continue"];
        } else if (saved.command === "codex") {
          resumeArgs = ["resume", "--last"];
        } else {
          resumeArgs = [];
        }
      }
      const args = [...resumeArgs, ...saved.args];
      debug(`resuming ${saved.command} with backendSessionId=${bsid ?? "none (fallback)"}`, "session");
      this.createSession(saved.command, args, toolCfg.preambleFlag, saved.toolConfigKey, undefined, undefined, saved.worktreePath);
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
      ? state.sessions.filter(s => s.tool === toolFilter || s.toolConfigKey === toolFilter)
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
        const formattedTurns = turns.map(t => {
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
      const liveContext = buildContextPreamble(
        sessionsToRestore.filter(s => s.id !== saved.id).map(s => s.id)
      );

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
        const registry = loadRegistry(worktreePath);
        const wt = registry.worktrees.find(w => w.path === worktreePath);
        const branch = wt?.branch ?? "unknown";
        const siblings = registry.worktrees
          .filter(w => w.path !== worktreePath)
          .map(w => `${w.name} (${w.branch})`)
          .join(", ");
        preamble +=
          `\n\nYou are working in git worktree '${wt?.name ?? "unknown"}' at ${worktreePath} on branch '${branch}'.` +
          `\nYour main repository is at ${registry.mainRepoPath}.` +
          (siblings ? `\nSibling worktrees: ${siblings}` : "") +
          `\nStay in your worktree directory — do not cd to other worktrees or the main repo.`;
      } catch {
        // If we can't load registry, add basic info
        preamble += `\n\nYou are working in a git worktree at ${worktreePath}. Stay in this directory.`;
      }
    }

    if (extraPreamble) {
      preamble += "\n" + extraPreamble;
    }

    let finalArgs = preambleFlag
      ? [...args, ...preambleFlag, preamble]
      : [...args];

    // Inject backend session ID flag (e.g. --session-id <uuid>)
    if (sessionIdFlag && backendSessionId) {
      const expandedFlag = sessionIdFlag.map(a => a.replace("{sessionId}", backendSessionId));
      finalArgs = [...finalArgs, ...expandedFlag];
    }

    if (preambleFlag) {
      debugPreamble(command, Buffer.byteLength(preamble));
    }
    debug(`creating session: ${command} (configKey=${toolConfigKey ?? "cli"}, backendId=${backendSessionId ?? "none"})`, "session");

    const session = new PtySession({ command, args: finalArgs, cols, rows: this.toolRows, id: sessionId, cwd: worktreePath });
    // Store backend session ID for resume
    (session as any)._backendSessionId = backendSessionId;

    // For tools without sessionIdFlag (e.g. codex), try to capture the backend session ID after startup
    if (!backendSessionId && command === "codex") {
      this.captureCodexSessionId(session);
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
      notifyComplete(session.id);
      // Capture git context on session exit (fire-and-forget)
      captureGitContext(session.id, session.command).catch(() => {});

      const idx = this.sessions.indexOf(session);
      if (idx === -1) return;

      this.sessions.splice(idx, 1);
      this.writeSessionsFile();
      this.contextWatcher.updateSessions(this.sessions.map(s => ({ id: s.id, command: s.command })));

      if (this.sessions.length === 0) {
        if (this.startedInDashboard) {
          // Stay in dashboard with no sessions
          this.setMode("dashboard");
          return;
        }
        this.resolveRun?.(_code);
        return;
      }

      // Adjust active index
      if (this.activeIndex >= this.sessions.length) {
        this.activeIndex = this.sessions.length - 1;
      }

      // Refresh view
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
    });

    // Track toolConfigKey, original args, and worktree path for state saving
    if (toolConfigKey) {
      this.sessionToolKeys.set(session.id, toolConfigKey);
    }
    this.sessionOriginalArgs.set(session.id, args);
    if (worktreePath) {
      this.sessionWorktreePaths.set(session.id, worktreePath);
    }

    this.sessions.push(session);
    this.writeSessionsFile();
    this.contextWatcher.updateSessions(this.sessions.map(s => ({ id: s.id, command: s.command })));
    if (this.sessions.length === 1) this.contextWatcher.start();

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
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const sourceWorktree = this.sessionWorktreePaths.get(sessionId);
    const sourceCwd = sourceWorktree ?? process.cwd();

    // Copy history file
    const sourceHistoryPath = join(getAimuxDir(sourceCwd), "history", `${sessionId}.jsonl`);
    const targetHistoryDir = join(getAimuxDir(targetWorktreePath), "history");
    mkdirSync(targetHistoryDir, { recursive: true });
    if (existsSync(sourceHistoryPath)) {
      copyFileSync(sourceHistoryPath, join(targetHistoryDir, `${sessionId}.jsonl`));
    }

    // Copy context directory
    const sourceContextDir = join(getAimuxDir(sourceCwd), "context", sessionId);
    const targetContextDir = join(getAimuxDir(targetWorktreePath), "context", sessionId);
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
      const formattedTurns = turns.map(t => {
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

  private focusSession(index: number): void {
    if (index < 0 || index >= this.sessions.length) return;

    this.activeIndex = index;
    this.setMode("focused");

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
        if (action.index < this.sessions.length) {
          this.focusSession(action.index);
        }
        break;

      case "next":
        if (this.sessions.length > 1) {
          this.focusSession((this.activeIndex + 1) % this.sessions.length);
        }
        break;

      case "prev":
        if (this.sessions.length > 1) {
          this.focusSession(
            (this.activeIndex - 1 + this.sessions.length) % this.sessions.length
          );
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

      case "worktree-create":
        this.showWorktreeCreatePrompt();
        break;

      case "worktree-list":
        this.showWorktreeList();
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
      case "x":
        if (this.dashboardLevel === "sessions" && this.dashboardWorktreeSessions.length > 0) {
          const session = this.dashboardWorktreeSessions[this.dashboardSessionIndex];
          if (session) session.kill();
        }
        return;
      case "m":
        if (this.sessions.length > 0) {
          this.showMigratePicker();
        }
        return;
    }

    if (!hasWorktrees) {
      // No worktrees — flat session navigation (simple mode)
      switch (key) {
        case "down":
        case "j":
        case "n":
          if (this.sessions.length > 1) {
            this.activeIndex = (this.activeIndex + 1) % this.sessions.length;
            this.renderDashboard();
          }
          break;
        case "up":
        case "k":
        case "p":
          if (this.sessions.length > 1) {
            this.activeIndex = (this.activeIndex - 1 + this.sessions.length) % this.sessions.length;
            this.renderDashboard();
          }
          break;
        case "enter":
          if (this.sessions.length > 0) {
            this.focusSession(this.activeIndex);
          }
          break;
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
          this.focusedWorktreePath = this.worktreeNavOrder[
            (curIdx - 1 + this.worktreeNavOrder.length) % this.worktreeNavOrder.length
          ];
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
            // Update activeIndex to match
            const session = this.dashboardWorktreeSessions[this.dashboardSessionIndex];
            this.activeIndex = this.sessions.indexOf(session);
            this.renderDashboard();
          }
          break;
        case "up":
        case "k":
        case "p":
          if (this.dashboardWorktreeSessions.length > 1) {
            this.dashboardSessionIndex = (this.dashboardSessionIndex - 1 + this.dashboardWorktreeSessions.length) % this.dashboardWorktreeSessions.length;
            const session = this.dashboardWorktreeSessions[this.dashboardSessionIndex];
            this.activeIndex = this.sessions.indexOf(session);
            this.renderDashboard();
          }
          break;
        case "enter":
          if (this.dashboardWorktreeSessions.length > 0) {
            const session = this.dashboardWorktreeSessions[this.dashboardSessionIndex];
            const idx = this.sessions.indexOf(session);
            if (idx >= 0) this.focusSession(idx);
          }
          break;
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

  /** Get sessions belonging to the focused worktree */
  private updateWorktreeSessions(): void {
    this.dashboardWorktreeSessions = this.sessions.filter(s => {
      const wtPath = this.sessionWorktreePaths.get(s.id);
      return wtPath === this.focusedWorktreePath;
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
      const label = available
        ? `  [${i + 1}] ${tools[i][0]}`
        : `  [${i + 1}] ${tools[i][0]} (not installed)`;
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
          process.stdout.write(`\x1b7\x1b[${(process.stdout.rows ?? 24) - 2};1H\x1b[41;97m "${tool.command}" is not installed. Install it first. \x1b[0m\x1b8`);
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

    const dashSessions: DashboardSession[] = this.sessions.map((s, i) => {
      const wtPath = this.sessionWorktreePaths.get(s.id);
      return {
        index: i,
        id: s.id,
        command: s.command,
        status: s.status,
        active: i === this.activeIndex,
        worktreePath: wtPath,
      };
    });

    // Build worktree groups from registry (if available)
    let worktreeGroups: WorktreeGroup[] = [];
    try {
      const worktrees = listAllWorktrees();
      worktreeGroups = worktrees.map(wt => ({
        name: wt.name,
        branch: wt.branch,
        path: wt.path,
        status: wt.status,
        sessions: dashSessions.filter(s => s.worktreePath === wt.path),
      }));
    } catch {
      // Not in a git repo or no worktrees — skip grouping
    }

    // Build worktree navigation order: main repo first, then registered worktrees
    const hasWorktrees = worktreeGroups.length > 0;
    this.worktreeNavOrder = [undefined, ...worktreeGroups.map(wt => wt.path)];
    // Ensure focusedWorktreePath is valid
    if (!this.worktreeNavOrder.includes(this.focusedWorktreePath)) {
      this.focusedWorktreePath = undefined;
    }

    // Determine selected session for session-level cursor
    const selectedSession = this.dashboardLevel === "sessions" && this.dashboardWorktreeSessions.length > 0
      ? this.dashboardWorktreeSessions[this.dashboardSessionIndex]?.id
      : undefined;

    this.dashboard.update(
      dashSessions,
      worktreeGroups,
      this.focusedWorktreePath,
      hasWorktrees ? this.dashboardLevel : "sessions",
      selectedSession,
    );
    process.stdout.write(this.dashboard.render(cols, rows));
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

    const boxWidth = Math.max(...lines.map(l => l.length)) + 4;
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
          const info = createWorktree(name);
          debug(`worktree created from UI: ${info.name} at ${info.path}`, "worktree");
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

  private showWorktreeList(): void {
    this.worktreeListActive = true;
    this.renderWorktreeList();
  }

  private renderWorktreeList(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    let worktrees: Array<{ name: string; branch: string; status: string; path: string }> = [];
    try {
      worktrees = listAllWorktrees().map(wt => ({
        name: wt.name,
        branch: wt.branch,
        status: wt.status,
        path: wt.path,
      }));
    } catch {}

    const lines = ["Worktree Management:", ""];
    if (worktrees.length === 0) {
      lines.push("  No worktrees found.");
    } else {
      for (let i = 0; i < worktrees.length; i++) {
        const wt = worktrees[i];
        lines.push(`  [${i + 1}] ${wt.name} (${wt.branch}) — ${wt.status}`);
      }
    }
    lines.push("");
    lines.push("  [1-9] remove  [c] clean  [Esc] back");

    const boxWidth = Math.max(...lines.map(l => l.length)) + 4;
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

    if (key === "c") {
      // Clean worktrees
      this.worktreeListActive = false;
      try {
        const removed = cleanWorktrees();
        debug(`cleaned worktrees: ${removed.join(", ") || "none"}`, "worktree");
      } catch {}
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
        if (idx < worktrees.length) {
          removeWorktree(worktrees[idx].name);
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

  private showMigratePicker(): void {
    // Collect available worktrees to migrate to
    try {
      const worktrees = listAllWorktrees();
      const mainRepo = findMainRepo();
      this.migratePickerWorktrees = [
        { name: "(main)", path: mainRepo },
        ...worktrees.map(wt => ({ name: wt.name, path: wt.path })),
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
      const isCurrent = (wt.path === currentWt) || (!currentWt && wt.name === "(main)");
      const marker = isCurrent ? " (current)" : "";
      lines.push(`  [${i + 1}] ${wt.name}${marker}`);
    }
    lines.push("");
    lines.push("  [Esc] cancel");

    const boxWidth = Math.max(...lines.map(l => l.length)) + 4;
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
          try {
            this.migrateAgent(session.id, target.path);
            debug(`migrated ${session.id} to ${target.name}`, "worktree");
          } catch (err) {
            debug(`migration failed: ${err instanceof Error ? err.message : String(err)}`, "worktree");
          }
        }
      }
    }

    if (this.mode === "dashboard") {
      this.renderDashboard();
    } else if (this.sessions.length > 0) {
      this.focusSession(this.activeIndex);
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
      try { unlinkSync(filePath); } catch {}
    }
    this.writtenInstructionFiles.clear();
  }

  /** Write active sessions to .aimux/sessions.json so agents can discover each other */
  /**
   * Capture codex's backend session ID by watching its sessions directory
   * for a new file that appears after spawning.
   */
  private captureCodexSessionId(session: PtySession): void {
    const homedir = process.env.HOME ?? "";
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const sessionsDir = join(homedir, ".codex", "sessions", String(y), m, d);

    // Snapshot current files
    let beforeFiles: string[] = [];
    try {
      beforeFiles = readdirSync(sessionsDir);
    } catch {}

    // Check for new files after a delay
    const checkForNew = () => {
      try {
        const afterFiles = readdirSync(sessionsDir);
        const newFiles = afterFiles.filter(f => !beforeFiles.includes(f));
        for (const file of newFiles) {
          // Extract UUID from filename: rollout-{timestamp}-{UUID}.jsonl
          const match = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
          if (match) {
            (session as any)._backendSessionId = match[1];
            debug(`captured codex backendSessionId: ${match[1]}`, "session");
            return;
          }
        }
      } catch {}
    };

    // Try a few times with increasing delays
    setTimeout(checkForNew, 2000);
    setTimeout(checkForNew, 5000);
    setTimeout(checkForNew, 10000);
  }

  private writeSessionsFile(): void {
    const dir = getAimuxDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = this.sessions.map(s => ({
      id: s.id,
      tool: s.command,
      status: s.status,
      worktreePath: this.sessionWorktreePaths.get(s.id),
    }));
    writeFileSync(
      `${dir}/sessions.json`,
      JSON.stringify(data, null, 2) + "\n"
    );
  }

  /** Remove sessions file on exit */
  private removeSessionsFile(): void {
    try { unlinkSync(`${getAimuxDir()}/sessions.json`); } catch {}
  }

  /** Terminal rows available for the tool (total minus footer) */
  private get toolRows(): number {
    const rows = process.stdout.rows ?? 24;
    return this.mode === "focused" ? rows - Multiplexer.FOOTER_HEIGHT : rows;
  }

  /** Set scroll region to exclude footer row */
  private setupScrollRegion(): void {
    const rows = process.stdout.rows ?? 24;
    const toolRows = rows - Multiplexer.FOOTER_HEIGHT;
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

    const STATUS_ICONS: Record<string, string> = {
      running: "\x1b[33m●\x1b[0m",
      idle: "\x1b[32m●\x1b[0m",
      waiting: "\x1b[36m◉\x1b[0m",
      exited: "\x1b[31m○\x1b[0m",
    };

    // Build session indicators
    const parts: string[] = [];
    for (let i = 0; i < this.sessions.length; i++) {
      const s = this.sessions[i];
      const icon = STATUS_ICONS[s.status] ?? "?";
      const name = s.command;
      const active = i === this.activeIndex ? "\x1b[1m" : "\x1b[2m";
      const reset = "\x1b[0m";
      parts.push(`${active}${icon} ${i + 1}:${name}${reset}`);
    }

    const left = ` ${parts.join("  ")}`;
    const right = `^A ? help `;

    // Calculate visible lengths (strip ANSI for padding)
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const leftLen = stripAnsi(left).length;
    const rightLen = stripAnsi(right).length;
    const padLen = Math.max(0, cols - leftLen - rightLen);

    const footerContent = `\x1b[7m${left}${" ".repeat(padLen)}${right}\x1b[0m`;

    // Save cursor, move to footer row, draw, restore cursor
    process.stdout.write(
      `\x1b7` +
      `\x1b[${rows};1H` +
      footerContent +
      `\x1b8`
    );
  }

  /** Track previous statuses for notification on transition */
  private prevStatuses = new Map<string, string>();

  private startFooterRefresh(): void {
    if (this.footerInterval) return;
    this.renderFooter();
    // Refresh every 2s to pick up status changes + check for notifications
    this.footerInterval = setInterval(() => {
      if (this.mode === "focused") this.renderFooter();
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
    }, 2000);
  }

  private stopFooterRefresh(): void {
    if (this.footerInterval) {
      clearInterval(this.footerInterval);
      this.footerInterval = null;
    }
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

  /** Save session state to .aimux/state.json for resume/restore */
  private saveState(): void {
    if (this.sessions.length === 0) return;

    const dir = getAimuxDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const state: SavedState = {
      savedAt: new Date().toISOString(),
      cwd: process.cwd(),
      sessions: this.sessions.map(s => ({
        id: s.id,
        tool: s.command,
        toolConfigKey: this.sessionToolKeys.get(s.id) ?? s.command,
        command: s.command,
        args: this.sessionOriginalArgs.get(s.id) ?? [],
        backendSessionId: (s as any)._backendSessionId,
        worktreePath: this.sessionWorktreePaths.get(s.id),
      })),
    };

    writeFileSync(
      `${dir}/state.json`,
      JSON.stringify(state, null, 2) + "\n"
    );
  }

  /** Load saved state from .aimux/state.json */
  static loadState(cwd?: string): SavedState | null {
    const statePath = `${getAimuxDir(cwd)}/state.json`;
    if (!existsSync(statePath)) return null;

    try {
      const raw = readFileSync(statePath, "utf-8");
      const state = JSON.parse(raw) as SavedState;

      // Check staleness (>24h)
      const savedAt = new Date(state.savedAt).getTime();
      if (Date.now() - savedAt > 24 * 60 * 60 * 1000) return null;

      return state;
    } catch {
      return null;
    }
  }

  private teardown(): void {
    debug("teardown started", "session");
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
      session.destroy();
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
