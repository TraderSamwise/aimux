import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PtySession, type PtySessionOptions } from "./pty-session.js";
import { HotkeyHandler, type HotkeyAction } from "./hotkeys.js";
import { Dashboard, type DashboardSession } from "./dashboard.js";
import { captureGitContext, ContextWatcher, buildContextPreamble } from "./context/context-bridge.js";
import { readHistory } from "./context/history.js";
import { parseKeys } from "./key-parser.js";
import { loadConfig, getAimuxDir, initProject, type ToolConfig } from "./config.js";
import { debug, debugPreamble, closeDebug } from "./debug.js";

export type MuxMode = "focused" | "dashboard";

export interface SessionState {
  id: string;
  tool: string;
  toolConfigKey: string;
  command: string;
  args: string[];
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
  private footerInterval: ReturnType<typeof setInterval> | null = null;
  private contextWatcher = new ContextWatcher();
  /** Maps session ID → toolConfigKey for state saving */
  private sessionToolKeys = new Map<string, string>();
  /** Maps session ID → original args (before preamble injection) */
  private sessionOriginalArgs = new Map<string, string[]>();
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
    this.createSession(opts.command, opts.args, toolConfig?.preambleFlag, toolConfigKey);

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

    // Spawn each session with resumeArgs
    for (const saved of sessionsToResume) {
      const toolCfg = config.tools[saved.toolConfigKey];
      if (!toolCfg) continue;

      const args = [...(toolCfg.resumeArgs ?? []), ...saved.args];
      this.createSession(saved.command, args, toolCfg.preambleFlag, saved.toolConfigKey);
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

  createSession(command: string, args: string[], preambleFlag?: string[], toolConfigKey?: string, extraPreamble?: string): PtySession {
    const cols = process.stdout.columns ?? 80;

    // Pre-generate session ID so we can reference it in the preamble
    const sessionId = `${command}-${Math.random().toString(36).slice(2, 8)}`;

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
    if (extraPreamble) {
      preamble += "\n" + extraPreamble;
    }
    const finalArgs = preambleFlag
      ? [...args, ...preambleFlag, preamble]
      : args;

    if (preambleFlag) {
      debugPreamble(command, Buffer.byteLength(preamble));
    }
    debug(`creating session: ${command} (configKey=${toolConfigKey ?? "cli"})`, "session");

    const session = new PtySession({ command, args: finalArgs, cols, rows: this.toolRows, id: sessionId });

    // Forward output to stdout only when this session is active and focused
    session.onData((data) => {
      if (this.mode === "focused" && this.sessions[this.activeIndex] === session) {
        process.stdout.write(data);
      }
    });

    // Handle session exit
    session.onExit((_code) => {
      debug(`session exited: ${session.id} (code=${_code})`, "session");
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

    // Track toolConfigKey and original args for state saving
    if (toolConfigKey) {
      this.sessionToolKeys.set(session.id, toolConfigKey);
    }
    this.sessionOriginalArgs.set(session.id, args);

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

    // Digits 1-9: focus session
    if (key >= "1" && key <= "9") {
      const index = parseInt(key) - 1;
      if (index < this.sessions.length) {
        this.focusSession(index);
      }
      return;
    }

    switch (key) {
      case "c":
        this.showToolPicker();
        break;
      case "x":
        if (this.sessions.length > 0) {
          this.sessions[this.activeIndex].kill();
        }
        break;
      case "q":
        this.resolveRun?.(0);
        break;
      case "d":
      case "escape":
        if (this.sessions.length > 0) {
          this.focusSession(this.activeIndex);
        }
        break;
      case "n":
      case "down":
      case "j":
        if (this.sessions.length > 1) {
          this.activeIndex = (this.activeIndex + 1) % this.sessions.length;
          this.renderDashboard();
        }
        break;
      case "p":
      case "up":
      case "k":
        if (this.sessions.length > 1) {
          this.activeIndex =
            (this.activeIndex - 1 + this.sessions.length) % this.sessions.length;
          this.renderDashboard();
        }
        break;
      case "enter":
        if (this.sessions.length > 0) {
          this.focusSession(this.activeIndex);
        }
        break;
    }
  }

  private showToolPicker(): void {
    const config = loadConfig();
    const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);

    if (tools.length === 1) {
      // Only one tool — skip picker, spawn directly
      const [key, tool] = tools[0];
      this.createSession(tool.command, tool.args, tool.preambleFlag, key);
      return;
    }

    this.pickerActive = true;

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const lines = ["Select tool:"];
    for (let i = 0; i < tools.length; i++) {
      lines.push(`  [${i + 1}] ${tools[i][0]}`);
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
        this.createSession(tool.command, tool.args, tool.preambleFlag, key);
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

    const dashSessions: DashboardSession[] = this.sessions.map((s, i) => ({
      index: i,
      id: s.id,
      command: s.command,
      status: s.status,
      active: i === this.activeIndex,
    }));

    this.dashboard.update(dashSessions);
    process.stdout.write(this.dashboard.render(cols, rows));
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

    for (const [, tool] of Object.entries(config.tools)) {
      if (!tool.instructionsFile || !tool.enabled) continue;
      const filePath = join(process.cwd(), tool.instructionsFile);
      // Don't overwrite if it already exists and wasn't written by us
      if (existsSync(filePath) && !this.writtenInstructionFiles.has(filePath)) {
        debug(`skipping ${tool.instructionsFile} — already exists`, "context");
        continue;
      }
      writeFileSync(filePath, preamble);
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
  private writeSessionsFile(): void {
    const dir = getAimuxDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = this.sessions.map(s => ({
      id: s.id,
      tool: s.command,
      status: s.status,
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

  private startFooterRefresh(): void {
    if (this.footerInterval) return;
    this.renderFooter();
    // Refresh every 2s to pick up status changes
    this.footerInterval = setInterval(() => {
      if (this.mode === "focused") this.renderFooter();
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
