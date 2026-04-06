import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { debug } from "./debug.js";
import { getProjectStateDirFor } from "./paths.js";

export interface TmuxExecOptions {
  cwd?: string;
}

export type TmuxExec = (args: string[], options?: TmuxExecOptions) => string;
export type TmuxInteractiveExec = (args: string[], options?: TmuxExecOptions) => void;

export interface TmuxWindowInfo {
  id: string;
  index: number;
  name: string;
  active: boolean;
  activity?: number;
}

export interface TmuxSessionRef {
  projectRoot: string;
  projectId: string;
  sessionName: string;
}

export interface TmuxTarget {
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
}

export interface TmuxClientInfo {
  tty: string;
  sessionName: string;
  windowId: string;
  name: string;
}

export interface OpenTargetOptions {
  insideTmux?: boolean;
  alreadyResolved?: boolean;
}

export interface CaptureTargetOptions {
  /** Number of lines from the bottom of scrollback to include. */
  startLine?: number;
  /** Preserve escape sequences in the captured output. */
  includeEscapes?: boolean;
}

export interface TmuxCommandSpec {
  cwd: string;
  command: string;
  args: string[];
}

export interface TmuxWindowMetadata {
  kind?: "agent" | "service";
  sessionId: string;
  command: string;
  args: string[];
  toolConfigKey: string;
  backendSessionId?: string;
  worktreePath?: string;
  label?: string;
  role?: string;
  activity?: string;
  attention?: string;
  unseenCount?: number;
  statusText?: string;
}

export function isDashboardWindowName(name: string): boolean {
  return name === "dashboard" || name.startsWith("dashboard-");
}

export const MANAGED_TMUX_SESSION_OPTIONS = Object.freeze({
  prefix: "C-a",
  prefix2: "C-b",
  mouse: "on",
  extendedKeys: "always",
  extendedKeysFormat: "csi-u",
});

export const MANAGED_TMUX_TERMINAL_FEATURES = Object.freeze(["xterm*:extkeys", "xterm*:hyperlinks"] as const);

export const MANAGED_TMUX_AGENT_WINDOW_OPTIONS = Object.freeze({
  allowPassthrough: "on",
});

const MODIFIED_ENTER_HEX = "1b 5b 31 33 3b 32 75";
const DEFAULT_EXEC: TmuxExec = (args, options) =>
  execFileSync("tmux", args, {
    cwd: options?.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const DEFAULT_INTERACTIVE_EXEC: TmuxInteractiveExec = (args, options) => {
  const result = spawnSync("tmux", args, {
    cwd: options?.cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || `tmux ${args.join(" ")} failed`);
  }
};

export class TmuxRuntimeManager {
  constructor(
    private readonly exec: TmuxExec = DEFAULT_EXEC,
    private readonly interactiveExec: TmuxInteractiveExec = DEFAULT_INTERACTIVE_EXEC,
  ) {}

  isAvailable(): boolean {
    try {
      this.exec(["-V"]);
      return true;
    } catch {
      return false;
    }
  }

  getVersion(): string | null {
    try {
      return this.exec(["-V"]);
    } catch {
      return null;
    }
  }

  getProjectSession(projectRoot: string): TmuxSessionRef {
    const projectId = createHash("sha1").update(projectRoot).digest("hex").slice(0, 10);
    const slug = basename(projectRoot).replace(/[^a-zA-Z0-9_-]+/g, "-") || "project";
    let prefix = "aimux";
    try {
      prefix = loadConfig().runtime.tmux.sessionPrefix || "aimux";
    } catch {}
    return {
      projectRoot,
      projectId,
      sessionName: `${prefix}-${slug}-${projectId}`,
    };
  }

  getProjectClientSessionName(hostSessionName: string, clientSuffix: string): string {
    return `${hostSessionName}-client-${clientSuffix}`;
  }

  isClientSessionName(sessionName: string): boolean {
    return /-client-[a-f0-9]{8}$/.test(sessionName);
  }

  getOpenSessionName(sessionName: string, insideTmux = this.isInsideTmux()): string {
    return this.resolveOpenSessionName(sessionName, insideTmux);
  }

  peekOpenSessionName(sessionName: string, insideTmux = this.isInsideTmux()): string {
    if (!this.isManagedSessionName(sessionName) || this.isClientSessionName(sessionName)) return sessionName;
    const clientSuffix = this.resolveClientSuffix(insideTmux);
    if (!clientSuffix) return sessionName;
    return this.getProjectClientSessionName(sessionName, clientSuffix);
  }

  private ensureClientSession(hostSessionName: string, clientSessionName: string, projectRoot: string): void {
    const dashboardName = this.getDashboardWindowName();
    const clientSessionExists = this.hasSession(clientSessionName);
    const hostDashboard = this.listWindows(hostSessionName).find((window) => isDashboardWindowName(window.name));
    const existingDashboard = clientSessionExists
      ? this.listWindows(clientSessionName).find((window) => isDashboardWindowName(window.name))
      : undefined;
    const needsRecreate =
      !!hostDashboard &&
      !!existingDashboard &&
      (existingDashboard.id === hostDashboard.id || existingDashboard.name === "dashboard");

    if (needsRecreate) {
      this.exec(["kill-session", "-t", clientSessionName]);
    }

    if (!clientSessionExists || needsRecreate) {
      this.exec(
        [
          "new-session",
          "-d",
          "-s",
          clientSessionName,
          "-c",
          projectRoot,
          "-n",
          dashboardName,
          "sh",
          "-lc",
          "tail -f /dev/null",
        ],
        { cwd: projectRoot },
      );
      this.configureSession(clientSessionName, projectRoot);
      this.exec(["set-option", "-t", clientSessionName, "@aimux-host-session", hostSessionName]);
      return;
    }

    this.configureSession(clientSessionName, projectRoot);
    this.exec(["set-option", "-t", clientSessionName, "@aimux-host-session", hostSessionName]);
  }

  private ensureLinkedWindow(clientSessionName: string, target: TmuxTarget): TmuxTarget {
    const existing = this.getTargetByWindowId(clientSessionName, target.windowId);
    if (existing) return existing;
    this.exec(["link-window", "-d", "-s", target.windowId, "-t", clientSessionName]);
    const linked = this.getTargetByWindowId(clientSessionName, target.windowId);
    if (!linked) {
      throw new Error(`Failed to link window ${target.windowId} into tmux session ${clientSessionName}`);
    }
    return linked;
  }

  private getSessionPrefix(): string {
    try {
      return loadConfig().runtime.tmux.sessionPrefix || "aimux";
    } catch {
      return "aimux";
    }
  }

  isManagedSessionName(sessionName: string): boolean {
    return sessionName.startsWith(`${this.getSessionPrefix()}-`);
  }

  hasSession(sessionName: string): boolean {
    try {
      this.exec(["has-session", "-t", sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  ensureProjectSession(projectRoot: string, dashboardCommand?: TmuxCommandSpec): TmuxSessionRef {
    const session = this.getProjectSession(projectRoot);
    const exists = this.hasSession(session.sessionName);
    if (!exists) {
      const argv =
        dashboardCommand && dashboardCommand.args.length >= 0
          ? [
              "new-session",
              "-d",
              "-s",
              session.sessionName,
              "-c",
              dashboardCommand.cwd,
              "-n",
              "dashboard",
              dashboardCommand.command,
              ...dashboardCommand.args,
            ]
          : [
              "new-session",
              "-d",
              "-s",
              session.sessionName,
              "-c",
              projectRoot,
              "-n",
              "dashboard",
              "sh",
              "-lc",
              "printf ''",
            ];
      this.exec(argv, { cwd: projectRoot });
    }
    this.configureSession(session.sessionName, projectRoot);
    return session;
  }

  listWindows(sessionName: string): TmuxWindowInfo[] {
    let raw = "";
    try {
      raw = this.exec([
        "list-windows",
        "-t",
        sessionName,
        "-F",
        "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}",
      ]);
    } catch {
      return [];
    }
    if (!raw) return [];
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, index, name, active, activity] = line.split("\t");
        return {
          id,
          index: Number(index),
          name,
          active: active === "1",
          activity: activity ? Number(activity) : undefined,
        };
      });
  }

  listSessionNames(): string[] {
    let raw = "";
    try {
      raw = this.exec(["list-sessions", "-F", "#{session_name}"]);
    } catch {
      return [];
    }
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  getTargetByWindowId(sessionName: string, windowId: string): TmuxTarget | null {
    const window = this.listWindows(sessionName).find((entry) => entry.id === windowId);
    if (!window) return null;
    return {
      sessionName,
      windowId: window.id,
      windowIndex: window.index,
      windowName: window.name,
    };
  }

  hasWindow(target: TmuxTarget): boolean {
    return this.getTargetByWindowId(target.sessionName, target.windowId) !== null;
  }

  isWindowAlive(target: TmuxTarget): boolean {
    try {
      const paneDead = this.exec(["display-message", "-p", "-t", target.windowId, "#{pane_dead}"]).trim();
      return paneDead !== "1";
    } catch {
      return false;
    }
  }

  ensureDashboardWindow(sessionName: string, projectRoot: string, dashboardCommand?: TmuxCommandSpec): TmuxTarget {
    const dashboardName = this.getDashboardWindowName();
    const existing = this.listWindows(sessionName).find((window) => isDashboardWindowName(window.name));
    if (existing) {
      this.renameWindow(existing.id, dashboardName);
      return {
        sessionName,
        windowId: existing.id,
        windowIndex: existing.index,
        windowName: dashboardName,
      };
    }
    const argv =
      dashboardCommand && dashboardCommand.args.length >= 0
        ? [
            "new-window",
            "-d",
            "-t",
            sessionName,
            "-c",
            dashboardCommand.cwd,
            "-n",
            dashboardName,
            dashboardCommand.command,
            ...dashboardCommand.args,
          ]
        : ["new-window", "-d", "-t", sessionName, "-c", projectRoot, "-n", dashboardName, "sh", "-lc", "printf ''"];
    this.exec(argv, {
      cwd: projectRoot,
    });
    const created = this.listWindows(sessionName).find((window) => window.name === dashboardName);
    if (!created) {
      throw new Error(`Failed to create dashboard window in tmux session ${sessionName}`);
    }
    return {
      sessionName,
      windowId: created.id,
      windowIndex: created.index,
      windowName: created.name,
    };
  }

  createWindow(
    sessionName: string,
    name: string,
    cwd: string,
    command: string,
    args: string[],
    options: { detached?: boolean } = {},
  ): TmuxTarget {
    const argv = [
      "new-window",
      ...(options.detached ? ["-d"] : []),
      "-P",
      "-t",
      sessionName,
      "-c",
      cwd,
      "-n",
      name,
      "-F",
      "#{window_id}\t#{window_index}\t#{window_name}",
      command,
      ...args,
    ];
    const raw = this.exec(argv, { cwd });
    const [windowId, index, windowName] = raw.split("\t");
    return {
      sessionName,
      windowId,
      windowIndex: Number(index),
      windowName,
    };
  }

  killWindow(target: TmuxTarget): void {
    this.exec(["kill-window", "-t", target.windowId]);
  }

  killSession(sessionName: string): void {
    this.exec(["kill-session", "-t", sessionName]);
  }

  renameWindow(windowTarget: string, name: string): void {
    this.exec(["rename-window", "-t", windowTarget, name]);
  }

  respawnWindow(target: TmuxTarget, spec: TmuxCommandSpec): void {
    this.exec(["respawn-window", "-k", "-t", target.windowId, "-c", spec.cwd, spec.command, ...spec.args], {
      cwd: spec.cwd,
    });
  }

  selectWindow(target: TmuxTarget): void {
    this.exec(["select-window", "-t", target.windowId]);
  }

  sendFocusIn(target: TmuxTarget): void {
    this.exec(["send-keys", "-t", target.windowId, "-H", "1b", "5b", "49"]);
  }

  switchClientToTarget(clientTty: string, target: TmuxTarget): void {
    debug(`tmux switchClientToTarget: client=${clientTty} target=${target.windowId}`, "fork");
    this.exec(["switch-client", "-c", clientTty, "-t", target.windowId]);
  }

  captureTarget(target: TmuxTarget, options: CaptureTargetOptions = {}): string {
    const startLine = options.startLine ?? "-";
    const args = ["capture-pane", "-p", "-J", "-t", target.windowId, "-S", String(startLine)];
    if (options.includeEscapes) args.splice(3, 0, "-e");
    return this.exec(args);
  }

  listClients(): TmuxClientInfo[] {
    const raw = this.exec(["list-clients", "-F", "#{client_tty}\t#{session_name}\t#{window_id}\t#{client_name}"]);
    if (!raw) return [];
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [tty, sessionName, windowId, name] = line.split("\t");
        return { tty, sessionName, windowId, name };
      });
  }

  findClientByTty(clientTty: string): TmuxClientInfo | null {
    const normalized = clientTty.trim();
    if (!normalized) return null;
    return this.listClients().find((client) => client.tty === normalized) ?? null;
  }

  getAttachedClientForTarget(target: TmuxTarget): TmuxClientInfo | null {
    const clientPrefix = `${target.sessionName}-client-`;
    const clients = this.listClients().filter(
      (client) => client.sessionName === target.sessionName || client.sessionName.startsWith(clientPrefix),
    );
    if (clients.length === 0) return null;
    return clients.find((client) => client.windowId === target.windowId) ?? clients[0] ?? null;
  }

  sendText(target: TmuxTarget, text: string): void {
    if (!text) return;
    debug(
      `tmux sendText: target=${target.windowId} bytes=${Buffer.byteLength(text)} preview=${JSON.stringify(text.slice(0, 180))}`,
      "fork",
    );
    this.exec(["send-keys", "-t", target.windowId, "-l", text]);
  }

  sendEnter(target: TmuxTarget): void {
    debug(`tmux sendEnter: target=${target.windowId}`, "fork");
    this.exec(["send-keys", "-t", target.windowId, "Enter"]);
  }

  sendClientEnter(clientTty: string): void {
    debug(`tmux sendClientEnter: client=${clientTty}`, "fork");
    this.exec(["send-keys", "-K", "-c", clientTty, "Enter"]);
  }

  sendClientCarriageReturn(clientTty: string, target: TmuxTarget): void {
    debug(`tmux sendClientCarriageReturn: client=${clientTty} target=${target.windowId}`, "fork");
    this.exec(["send-keys", "-c", clientTty, "-t", target.windowId, "-H", "0d"]);
  }

  sendCarriageReturn(target: TmuxTarget): void {
    debug(`tmux sendCarriageReturn: target=${target.windowId}`, "fork");
    this.exec(["send-keys", "-t", target.windowId, "-H", "0d"]);
  }

  sendEscape(target: TmuxTarget): void {
    debug(`tmux sendEscape: target=${target.windowId}`, "fork");
    this.exec(["send-keys", "-t", target.windowId, "-H", "1b"]);
  }

  sendModifiedEnter(target: TmuxTarget): void {
    debug(`tmux sendModifiedEnter: target=${target.windowId} hex=${MODIFIED_ENTER_HEX}`, "fork");
    this.exec(["send-keys", "-t", target.windowId, "-H", ...MODIFIED_ENTER_HEX.split(" ")]);
  }

  sendKey(target: TmuxTarget, key: string): void {
    debug(`tmux sendKey: target=${target.windowId} key=${key}`, "fork");
    this.exec(["send-keys", "-t", target.windowId, key]);
  }

  setWindowMetadata(target: TmuxTarget | string, metadata: TmuxWindowMetadata): void {
    const windowTarget = typeof target === "string" ? target : target.windowId;
    this.exec(["set-window-option", "-q", "-t", windowTarget, "@aimux-meta", JSON.stringify(metadata)]);
  }

  setWindowOption(target: TmuxTarget | string, key: string, value: string): void {
    const windowTarget = typeof target === "string" ? target : target.windowId;
    this.exec(["set-window-option", "-q", "-t", windowTarget, key, value]);
  }

  setSessionOption(sessionName: string, key: string, value: string): void {
    this.exec(["set-option", "-t", sessionName, key, value]);
  }

  applyManagedAgentWindowPolicy(target: TmuxTarget | string, toolConfigKey: string): void {
    this.setWindowOption(target, "@aimux-tool", toolConfigKey);
    this.setWindowOption(target, "allow-passthrough", MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allowPassthrough);
  }

  getWindowOption(target: TmuxTarget | string, key: string): string | null {
    const windowTarget = typeof target === "string" ? target : target.windowId;
    try {
      const value = this.exec(["show-window-options", "-v", "-t", windowTarget, key]);
      return value.trim() || null;
    } catch {
      return null;
    }
  }

  getWindowMetadata(target: TmuxTarget | string): TmuxWindowMetadata | null {
    const windowTarget = typeof target === "string" ? target : target.windowId;
    try {
      const raw = this.exec(["show-window-options", "-v", "-t", windowTarget, "@aimux-meta"]);
      return JSON.parse(raw) as TmuxWindowMetadata;
    } catch {
      return null;
    }
  }

  listManagedWindows(sessionName: string): Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> {
    const windows = this.listWindows(sessionName);
    const managed: Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> = [];
    for (const window of windows) {
      const target: TmuxTarget = {
        sessionName,
        windowId: window.id,
        windowIndex: window.index,
        windowName: window.name,
      };
      const metadata = this.getWindowMetadata(target);
      if (!metadata) continue;
      managed.push({ target, metadata });
    }
    return managed;
  }

  listProjectManagedWindows(projectRoot: string): Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> {
    const hostSession = this.getProjectSession(projectRoot).sessionName;
    const sessionNames = this.listSessionNames().filter(
      (name) => name === hostSession || name.startsWith(`${hostSession}-client-`),
    );
    const seenWindowIds = new Set<string>();
    const managed: Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> = [];
    for (const sessionName of sessionNames) {
      for (const entry of this.listManagedWindows(sessionName)) {
        if (seenWindowIds.has(entry.target.windowId)) continue;
        seenWindowIds.add(entry.target.windowId);
        managed.push(entry);
      }
    }
    return managed;
  }

  findManagedWindow(
    sessionName: string,
    matcher: { sessionId?: string; backendSessionId?: string },
  ): { target: TmuxTarget; metadata: TmuxWindowMetadata } | null {
    if (!matcher.sessionId && !matcher.backendSessionId) return null;
    for (const entry of this.listManagedWindows(sessionName)) {
      if (matcher.sessionId && entry.metadata.sessionId === matcher.sessionId) return entry;
      if (matcher.backendSessionId && entry.metadata.backendSessionId === matcher.backendSessionId) return entry;
    }
    return null;
  }

  attachSession(sessionName: string, windowIndex?: number): void {
    const target = windowIndex === undefined ? sessionName : `${sessionName}:${windowIndex}`;
    this.interactiveExec(["attach-session", "-t", target]);
  }

  detachClient(): void {
    this.interactiveExec(["detach-client"]);
  }

  switchToLastClientSession(): void {
    this.interactiveExec(["switch-client", "-l"]);
  }

  currentClientSession(): string | null {
    try {
      return this.exec(["display-message", "-p", "#{client_session}"]);
    } catch {
      return null;
    }
  }

  displayMessage(format: string, target?: string): string | null {
    try {
      const args = target ? ["display-message", "-p", "-t", target, format] : ["display-message", "-p", format];
      const value = this.exec(args);
      return value.trim() || null;
    } catch {
      return null;
    }
  }

  getSessionOption(sessionName: string, key: string): string | null {
    try {
      const value = this.exec(["show-options", "-v", "-t", sessionName, key]);
      return value.trim() || null;
    } catch {
      return null;
    }
  }

  setReturnSession(sessionName: string, returnSessionName: string): void {
    this.exec(["set-option", "-t", sessionName, "@aimux-return-session", returnSessionName]);
  }

  getReturnSession(sessionName: string): string | null {
    try {
      const value = this.exec(["show-options", "-v", "-t", sessionName, "@aimux-return-session"]);
      return value.trim() || null;
    } catch {
      return null;
    }
  }

  leaveManagedSession(options: { insideTmux?: boolean; sessionName?: string } = {}): void {
    const activeSession = options.insideTmux
      ? (this.currentClientSession() ?? options.sessionName)
      : options.sessionName;
    if (options.insideTmux && activeSession) {
      const returnSession = this.getReturnSession(activeSession);
      const managedPrefix = `${this.getSessionPrefix()}-`;
      const isExternalReturn =
        returnSession && returnSession !== activeSession && !returnSession.startsWith(managedPrefix);
      if (isExternalReturn) {
        try {
          this.interactiveExec(["switch-client", "-t", returnSession!]);
          return;
        } catch {}
      }
    }
    this.detachClient();
  }

  switchClient(sessionName: string, windowIndex = 0): void {
    this.interactiveExec(["switch-client", "-t", `${sessionName}:${windowIndex}`]);
  }

  isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.TMUX);
  }

  openTarget(target: TmuxTarget, options: OpenTargetOptions = {}): void {
    const sessionName = options.alreadyResolved
      ? target.sessionName
      : this.resolveOpenSessionName(target.sessionName, options.insideTmux === true);
    const effectiveTarget =
      sessionName !== target.sessionName && !isDashboardWindowName(target.windowName)
        ? this.ensureLinkedWindow(sessionName, target)
        : {
            ...target,
            sessionName,
          };
    if (options.insideTmux) {
      const current = this.currentClientSession();
      if (current && current !== sessionName) {
        this.setReturnSession(sessionName, current);
      }
      this.switchClient(sessionName, effectiveTarget.windowIndex);
      return;
    }
    this.attachSession(sessionName, effectiveTarget.windowIndex);
  }

  private configureSession(sessionName: string, projectRoot: string): void {
    const controlScript = this.getControlScriptShellCommand();
    const statuslineCommand = this.getStatuslineCommandSpec();
    const projectStateDir = getProjectStateDirFor(projectRoot);
    this.exec(["set-option", "-t", sessionName, "@aimux-project-root", projectRoot]);
    this.exec(["set-option", "-t", sessionName, "prefix", MANAGED_TMUX_SESSION_OPTIONS.prefix]);
    this.exec(["set-option", "-t", sessionName, "prefix2", MANAGED_TMUX_SESSION_OPTIONS.prefix2]);
    this.exec(["set-option", "-t", sessionName, "mouse", MANAGED_TMUX_SESSION_OPTIONS.mouse]);
    this.exec(["set-option", "-t", sessionName, "repeat-time", "300"]);
    this.exec(["set-option", "-t", sessionName, "focus-events", "on"]);
    this.exec(["set-option", "-t", sessionName, "bell-action", "none"]);
    this.exec(["set-window-option", "-t", sessionName, "monitor-bell", "off"]);
    this.exec(["set-option", "-t", sessionName, "extended-keys", MANAGED_TMUX_SESSION_OPTIONS.extendedKeys]);
    this.exec([
      "set-option",
      "-t",
      sessionName,
      "extended-keys-format",
      MANAGED_TMUX_SESSION_OPTIONS.extendedKeysFormat,
    ]);
    for (const feature of MANAGED_TMUX_TERMINAL_FEATURES) {
      this.ensureTerminalFeature(sessionName, feature);
    }
    this.exec(["unbind-key", "-T", "root", "C-j"]);
    this.exec(["unbind-key", "-T", "root", "S-Enter"]);
    this.exec(["unbind-key", "-T", "root", "MouseDown1Pane"]);
    this.exec(["unbind-key", "-T", "root", "MouseDrag1Pane"]);
    this.exec(["unbind-key", "-T", "root", "WheelUpPane"]);
    this.exec(["unbind-key", "-T", "root", "WheelDownPane"]);
    this.exec(["bind-key", "-T", "root", "MouseDown1Pane", "select-pane", "-t", "=", "\\;", "send-keys", "-M"]);
    this.exec([
      "bind-key",
      "-T",
      "root",
      "MouseDrag1Pane",
      "if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -M'",
    ]);
    this.exec([
      "bind-key",
      "-T",
      "root",
      "C-j",
      "if-shell",
      "-F",
      "#{m/r:^(claude|codex)$,#{@aimux-tool}}",
      `send-keys -H ${MODIFIED_ENTER_HEX}`,
      "send-keys C-j",
    ]);
    this.exec([
      "bind-key",
      "-T",
      "root",
      "S-Enter",
      "if-shell",
      "-F",
      "#{m/r:^(claude|codex)$,#{@aimux-tool}}",
      `send-keys -H ${MODIFIED_ENTER_HEX}`,
      "send-keys S-Enter",
    ]);
    this.exec([
      "bind-key",
      "-T",
      "root",
      "WheelUpPane",
      "if-shell -F '#{||:#{alternate_on},#{mouse_any_flag}}' 'send-keys -M' \"if-shell -F '#{pane_in_mode}' 'send-keys -X -N 1 scroll-up' 'copy-mode -e \\; send-keys -X -N 1 scroll-up'\"",
    ]);
    this.exec([
      "bind-key",
      "-T",
      "root",
      "WheelDownPane",
      "if-shell -F '#{||:#{alternate_on},#{mouse_any_flag}}' 'send-keys -M' \"if-shell -F '#{pane_in_mode}' 'send-keys -X -N 1 scroll-down' ''\"",
    ]);
    this.exec(["unbind-key", "-T", "prefix", "s"]);
    this.exec(["unbind-key", "-T", "prefix", "n"]);
    this.exec(["unbind-key", "-T", "prefix", "p"]);
    this.exec(["unbind-key", "-T", "prefix", "d"]);
    this.exec(["unbind-key", "-T", "prefix", "u"]);
    this.exec(["unbind-key", "-T", "prefix", "Any"]);
    this.exec(["bind-key", "-T", "prefix", "C-a", "send-prefix"]);
    this.exec([
      "bind-key",
      "-r",
      "-T",
      "prefix",
      "n",
      "run-shell",
      "-b",
      `${controlScript} next --project-root ${shellQuote(projectRoot)} --project-state-dir ${shellQuote(projectStateDir)} --current-client-session '#{client_session}' --client-tty '#{client_tty}' --current-window '#{window_name}' --current-window-id '#{window_id}' --current-path '#{pane_current_path}' --pane-id '#{pane_id}' >/dev/null 2>&1`,
    ]);
    this.exec([
      "bind-key",
      "-r",
      "-T",
      "prefix",
      "p",
      "run-shell",
      "-b",
      `${controlScript} prev --project-root ${shellQuote(projectRoot)} --project-state-dir ${shellQuote(projectStateDir)} --current-client-session '#{client_session}' --client-tty '#{client_tty}' --current-window '#{window_name}' --current-window-id '#{window_id}' --current-path '#{pane_current_path}' --pane-id '#{pane_id}' >/dev/null 2>&1`,
    ]);
    this.exec([
      "bind-key",
      "-T",
      "prefix",
      "s",
      "run-shell",
      "-b",
      `${controlScript} menu --project-root ${shellQuote(projectRoot)} --project-state-dir ${shellQuote(projectStateDir)} --current-client-session '#{client_session}' --client-tty '#{client_tty}' --current-window '#{window_name}' --current-window-id '#{window_id}' --current-path '#{pane_current_path}' --pane-id '#{pane_id}' >/dev/null 2>&1`,
    ]);
    this.exec([
      "bind-key",
      "-T",
      "prefix",
      "u",
      "run-shell",
      "-b",
      `${controlScript} attention --project-root ${shellQuote(projectRoot)} --project-state-dir ${shellQuote(projectStateDir)} --current-client-session '#{client_session}' --client-tty '#{client_tty}' --current-window '#{window_name}' --current-window-id '#{window_id}' --current-path '#{pane_current_path}' --pane-id '#{pane_id}' >/dev/null 2>&1`,
    ]);
    this.exec(["bind-key", "-T", "prefix", "d", "select-window", "-t", ":0"]);
    this.exec([
      "bind-key",
      "-T",
      "prefix",
      "q",
      "if-shell",
      "-F",
      "#{@aimux-project-root}",
      "switch-client -T root",
      "display-panes",
    ]);
    this.exec(["bind-key", "-T", "prefix", "Any", "switch-client", "-T", "root"]);
    this.exec(["set-option", "-t", sessionName, "status", "2"]);
    this.exec(["set-option", "-t", sessionName, "status-interval", "0"]);
    this.exec(["set-option", "-t", sessionName, "status-style", "bg=colour236,fg=colour252"]);
    this.exec(["set-option", "-t", sessionName, "message-style", "bg=colour24,fg=colour255,bold"]);
    this.exec(["set-option", "-t", sessionName, "message-command-style", "bg=colour24,fg=colour255"]);
    this.exec(["set-option", "-t", sessionName, "window-status-separator", " "]);
    this.exec(["set-option", "-t", sessionName, "window-status-format", ""]);
    this.exec(["set-option", "-t", sessionName, "window-status-current-format", ""]);
    const top = `${statuslineCommand.command} ${statuslineCommand.args.map(shellQuote).join(" ")} --line top --project-state-dir ${shellQuote(projectStateDir)} --current-session '#{session_name}' --current-window '#{window_name}' --current-window-id '#{window_id}'`;
    const bottom = `${statuslineCommand.command} ${statuslineCommand.args.map(shellQuote).join(" ")} --line bottom --project-state-dir ${shellQuote(projectStateDir)} --current-session '#{session_name}' --current-window '#{window_name}' --current-window-id '#{window_id}'`;
    this.exec(["set-option", "-t", sessionName, "status-left", ""]);
    this.exec(["set-option", "-t", sessionName, "status-right", ""]);
    this.exec([
      "set-option",
      "-t",
      sessionName,
      "status-format[0]",
      `#[bg=colour238,fg=colour255,bold] #(${top}) #[default]`,
    ]);
    this.exec([
      "set-option",
      "-t",
      sessionName,
      "status-format[1]",
      `#[bg=colour236,fg=colour252] #(${bottom}) #[default]`,
    ]);
  }

  refreshStatus(): void {
    try {
      this.exec(["refresh-client", "-S"]);
    } catch {}
  }

  private ensureTerminalFeature(sessionName: string, feature: string): void {
    const current = this.getSessionOption(sessionName, "terminal-features");
    const features = current
      ?.split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (features?.includes(feature)) return;
    this.exec(["set-option", "-as", "-t", sessionName, "terminal-features", `,${feature}`]);
  }

  private resolveOpenSessionName(sessionName: string, insideTmux: boolean): string {
    if (!this.isManagedSessionName(sessionName) || this.isClientSessionName(sessionName)) return sessionName;
    const clientSuffix = this.resolveClientSuffix(insideTmux);
    if (!clientSuffix) return sessionName;
    const clientSessionName = this.getProjectClientSessionName(sessionName, clientSuffix);
    const projectRoot = this.getSessionOption(sessionName, "@aimux-project-root");
    if (projectRoot) {
      this.ensureClientSession(sessionName, clientSessionName, projectRoot);
    }
    return clientSessionName;
  }

  private getDashboardWindowName(): string {
    return "dashboard";
  }

  private normalizeClientSuffix(value: string): string {
    if (/^[a-f0-9]{8}$/.test(value)) return value;
    return createHash("sha1").update(value).digest("hex").slice(0, 8);
  }

  private resolveClientSuffix(insideTmux: boolean): string | null {
    const override = process.env.AIMUX_CLIENT_KEY?.trim();
    if (override) return this.normalizeClientSuffix(override);
    if (insideTmux) {
      const currentSession = this.currentClientSession();
      if (currentSession) {
        const match = currentSession.match(/-client-([a-f0-9]{8})$/);
        if (match) return match[1]!;
      }
      const clientTty = this.displayMessage("#{client_tty}");
      const clientPid = this.displayMessage("#{client_pid}");
      if (clientTty || clientPid) return this.normalizeClientSuffix(`${clientTty ?? "tty"}:${clientPid ?? "pid"}`);
      return null;
    }
    try {
      const tty = execFileSync("tty", {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "ignore"],
      }).trim();
      return this.normalizeClientSuffix(tty);
    } catch {
      return null;
    }
  }

  private getStatuslineCommandSpec(): TmuxCommandSpec {
    const currentFile = fileURLToPath(import.meta.url);
    const scriptPath = join(dirname(currentFile), "..", "scripts", "tmux-statusline.sh");
    return {
      cwd: process.cwd(),
      command: "sh",
      args: [scriptPath],
    };
  }

  private getControlScriptShellCommand(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const scriptPath = join(dirname(currentFile), "..", "scripts", "tmux-control.sh");
    return `sh ${shellQuote(scriptPath)}`;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
