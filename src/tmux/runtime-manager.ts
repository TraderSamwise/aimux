import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { debug, log } from "../debug.js";
import { getProjectIdFor, getProjectStateDirFor } from "../paths.js";
import {
  AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
  getRuntimeOwnerId,
  TMUX_RUNTIME_CONTRACT_OPTION,
  TMUX_RUNTIME_OWNER_OPTION,
} from "../runtime-owner.js";
import type { SessionUserLabel } from "../session-semantics.js";
import type { SessionTeamMetadata } from "../team.js";

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
  paneDead?: boolean;
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
  paneDead?: boolean;
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
  /** Switch this specific client (by tty) instead of the ambient one — needed
   * when opening from a display-popup whose own client is ephemeral. */
  clientTty?: string;
  /** Client suffix to resolve the per-client session, when the ambient client
   * can't be trusted (popup). Usually the `-client-XXXXXXXX` suffix. */
  clientSuffix?: string;
  /** Return-session to record on the target (defaults to the ambient client session). */
  returnSessionName?: string;
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
  createdAt?: string;
  backendSessionId?: string;
  team?: SessionTeamMetadata;
  worktreePath?: string;
  label?: string;
  launchCommandLine?: string;
  role?: string;
  activity?: string;
  attention?: string;
  unseenCount?: number;
  statusText?: string;
  /** Dashboard-semantic user state label, so Exposé matches the dashboard. */
  userLabel?: SessionUserLabel;
  /** Dashboard time-anchor: the timestamp to show as relative recency... */
  recencyAt?: string;
  /** ...and the verb describing it ("output", "prompted", "idle", …). */
  recencyLabel?: string;
}

export function isDashboardWindowName(name: string): boolean {
  return name === "dashboard" || name.startsWith("dashboard-");
}

export function isMetaDashboardWindowName(name: string): boolean {
  return name === "meta-dashboard" || name.startsWith("meta-dashboard-");
}

export const MANAGED_TMUX_SESSION_OPTIONS = Object.freeze({
  prefix: "C-a",
  prefix2: "C-b",
  mouse: "on",
  windowSize: "latest",
  extendedKeys: "always",
  extendedKeysFormat: "csi-u",
});

export const MANAGED_TMUX_TERMINAL_FEATURES = Object.freeze(["xterm*:extkeys", "xterm*:hyperlinks"] as const);

export const MANAGED_TMUX_AGENT_WINDOW_OPTIONS = Object.freeze({
  allowPassthrough: "on",
  aggressiveResize: "on",
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

export function buildDefaultRootMouseBindingsConfig(input: {
  openPaneLinkCommand: string;
  openStatusPrCommand: string;
}): string {
  const { openPaneLinkCommand, openStatusPrCommand } = input;
  return [
    `bind-key -T root MouseDown1Pane if-shell "${openPaneLinkCommand}" "" "select-pane -t = \\; send-keys -M"`,
    'bind-key -T root MouseDrag1Pane if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -M }',
    'bind-key -T root WheelUpPane if-shell -F "#{||:#{@aimux-tool},#{&&:#{!=:#{alternate_on},1},#{!=:#{mouse_any_flag},1}}}" "copy-mode -e \\; send-keys -X -N 1 scroll-up" "send-keys -M"',
    'bind-key -T root WheelDownPane if-shell -F "#{||:#{alternate_on},#{mouse_any_flag}}" { send-keys -M } { send-keys -M }',
    `bind-key -T root DoubleClick1Pane if-shell "${openPaneLinkCommand}" "" "send-keys -M"`,
    `bind-key -T root MouseDown1Status if-shell "${openStatusPrCommand}" "" ""`,
    `bind-key -T root DoubleClick1Status if-shell "${openStatusPrCommand}" "" ""`,
    `bind-key -T root MouseDown1StatusDefault if-shell "${openStatusPrCommand}" "" ""`,
    `bind-key -T root DoubleClick1StatusDefault if-shell "${openStatusPrCommand}" "" ""`,
    "bind-key -T copy-mode WheelUpPane send-keys -X -N 1 scroll-up",
    "bind-key -T copy-mode WheelDownPane send-keys -X -N 1 scroll-down",
    "bind-key -T copy-mode-vi WheelUpPane send-keys -X -N 1 scroll-up",
    "bind-key -T copy-mode-vi WheelDownPane send-keys -X -N 1 scroll-down",
    "bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel",
    "bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel",
    "",
  ].join("\n");
}

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
    const projectId = getProjectIdFor(projectRoot);
    let prefix = "aimux";
    try {
      prefix = loadConfig().runtime.tmux.sessionPrefix || "aimux";
    } catch {}
    return {
      projectRoot,
      projectId,
      sessionName: `${prefix}-${projectId}`,
    };
  }

  private getLegacyProjectSessionName(projectRoot: string): string {
    const projectId = createHash("sha1").update(projectRoot).digest("hex").slice(0, 10);
    const slug = basename(projectRoot).replace(/[^a-zA-Z0-9_-]+/g, "-") || "project";
    return `${this.getSessionPrefix()}-${slug}-${projectId}`;
  }

  repairLegacyProjectSessionNames(projectRoot: string, sessionNames = this.listSessionNames()): TmuxSessionRef {
    const session = this.getProjectSession(projectRoot);
    const legacySessionName = this.getLegacyProjectSessionName(projectRoot);
    if (legacySessionName === session.sessionName) return session;
    const knownNames = new Set(sessionNames);
    const rename = (from: string, to: string): void => {
      if (!knownNames.has(from) || knownNames.has(to)) return;
      this.exec(["rename-session", "-t", from, to]);
      knownNames.delete(from);
      knownNames.add(to);
    };
    rename(legacySessionName, session.sessionName);
    for (const name of [...knownNames]) {
      if (!name.startsWith(`${legacySessionName}-client-`)) continue;
      rename(name, `${session.sessionName}${name.slice(legacySessionName.length)}`);
    }
    return session;
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

  private getExistingRuntimeArtifact(paths: string[]): string {
    for (const path of paths) {
      try {
        statSync(path);
        return path;
      } catch {}
    }
    return paths[0]!;
  }

  private getManagedRuntimeBuildStamp(): string {
    const runtimeScript = fileURLToPath(import.meta.url);
    const controlScript = fileURLToPath(new URL("../../scripts/tmux-control.sh", import.meta.url));
    const statuslineScript = fileURLToPath(new URL("../../scripts/tmux-statusline.sh", import.meta.url));
    const dashboardScript = this.getExistingRuntimeArtifact([
      fileURLToPath(new URL("../main.js", import.meta.url)),
      fileURLToPath(new URL("../main.ts", import.meta.url)),
    ]);
    return [runtimeScript, controlScript, statuslineScript, dashboardScript]
      .map((path) => `${basename(path)}:${Math.trunc(statSync(path).mtimeMs)}`)
      .join("|");
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
    const runtimeBuildStamp = this.getManagedRuntimeBuildStamp();
    const clientWindows = clientSessionExists ? this.listWindows(clientSessionName) : [];
    const existingDashboard = clientWindows.find((window) => isDashboardWindowName(window.name));
    const currentHostSession = clientSessionExists
      ? this.getSessionOption(clientSessionName, "@aimux-host-session")
      : null;
    const currentProjectRoot = clientSessionExists
      ? this.getSessionOption(clientSessionName, "@aimux-project-root")
      : null;
    const currentRuntimeBuild = clientSessionExists
      ? this.getSessionOption(clientSessionName, "@aimux-runtime-build")
      : null;
    const dashboardAtZero = clientWindows.find((window) => window.index === 0);
    const needsRecreate =
      clientSessionExists &&
      (!existingDashboard ||
        existingDashboard.index !== 0 ||
        dashboardAtZero?.id !== existingDashboard.id ||
        currentHostSession !== hostSessionName ||
        currentProjectRoot !== projectRoot ||
        currentRuntimeBuild !== runtimeBuildStamp);

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
      this.setCurrentRuntimeContract(clientSessionName);
      this.exec(["set-option", "-t", clientSessionName, "@aimux-host-session", hostSessionName]);
      this.exec(["set-option", "-t", clientSessionName, "@aimux-runtime-build", runtimeBuildStamp]);
      return;
    }

    this.configureSession(clientSessionName, projectRoot);
    this.setCurrentRuntimeContract(clientSessionName);
    this.exec(["set-option", "-t", clientSessionName, "@aimux-host-session", hostSessionName]);
    this.exec(["set-option", "-t", clientSessionName, "@aimux-runtime-build", runtimeBuildStamp]);
  }

  private ensureLinkedWindow(clientSessionName: string, target: TmuxTarget, windowIndex?: number): TmuxTarget {
    const existing = this.getTargetByWindowId(clientSessionName, target.windowId);
    if (existing) return existing;
    if (windowIndex !== undefined) {
      const occupying = this.listWindows(clientSessionName).find((window) => window.index === windowIndex);
      if (occupying && occupying.id !== target.windowId) {
        if (!isDashboardWindowName(occupying.name)) {
          throw new Error(
            `Cannot replace non-dashboard tmux window ${occupying.id} at ${clientSessionName}:${windowIndex}`,
          );
        }
      }
    }
    const destination = windowIndex === undefined ? clientSessionName : `${clientSessionName}:${windowIndex}`;
    const args = ["link-window", "-d"];
    if (windowIndex !== undefined) args.push("-k");
    this.exec([...args, "-s", target.windowId, "-t", destination]);
    const linked = this.getTargetByWindowId(clientSessionName, target.windowId);
    if (!linked) {
      throw new Error(`Failed to link window ${target.windowId} into tmux session ${clientSessionName}`);
    }
    return linked;
  }

  linkWindowToSession(clientSessionName: string, target: TmuxTarget, windowIndex?: number): TmuxTarget {
    return this.ensureLinkedWindow(clientSessionName, target, windowIndex);
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
    let exists = this.hasSession(session.sessionName);
    if (!exists) {
      const before = this.listSessionNames();
      this.repairLegacyProjectSessionNames(projectRoot, before);
      exists = this.hasSession(session.sessionName);
    }
    const currentRuntimeContract = exists
      ? this.getSessionOption(session.sessionName, TMUX_RUNTIME_CONTRACT_OPTION)
      : null;
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
    if (!exists || !currentRuntimeContract) this.setCurrentRuntimeContract(session.sessionName);
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
        "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}",
      ]);
    } catch {
      return [];
    }
    if (!raw) return [];
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, index, name, active, activity, paneDead] = line.split("\t");
        return {
          id,
          index: Number(index),
          name,
          active: active === "1",
          activity: activity ? Number(activity) : undefined,
          paneDead: paneDead === "1",
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
      paneDead: window.paneDead,
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

  cancelCopyMode(target: TmuxTarget | string): void {
    const tmuxTarget = typeof target === "string" ? target : target.windowId;
    const inMode = this.displayMessage("#{pane_in_mode}", tmuxTarget);
    if (inMode !== "1") return;
    this.exec(["send-keys", "-t", tmuxTarget, "-X", "cancel"]);
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

  resizeTarget(target: TmuxTarget, cols: number, rows: number): void {
    this.exec(["resize-window", "-t", target.windowId, "-x", String(cols), "-y", String(rows)]);
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

  configureManagedSession(sessionName: string, projectRoot: string): void {
    this.configureSession(sessionName, projectRoot);
  }

  applyManagedAgentWindowPolicy(target: TmuxTarget | string, toolConfigKey: string): void {
    this.setWindowOption(target, "@aimux-tool", toolConfigKey);
    this.setWindowOption(target, "allow-passthrough", MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allowPassthrough);
    this.setWindowOption(target, "aggressive-resize", MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressiveResize);
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
    let raw = "";
    try {
      raw = this.exec([
        "list-windows",
        "-t",
        sessionName,
        "-F",
        "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
      ]);
    } catch {
      return [];
    }
    const windows = raw
      ? raw
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [id, index, name, active, activity, paneDead, metadataRaw = ""] = line.split("\t");
            return {
              id,
              index: Number(index),
              name,
              active: active === "1",
              activity: activity ? Number(activity) : undefined,
              paneDead: paneDead === "1",
              metadataRaw,
            };
          })
      : [];
    const managed: Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> = [];
    for (const window of windows) {
      const target: TmuxTarget = {
        sessionName,
        windowId: window.id,
        windowIndex: window.index,
        windowName: window.name,
        paneDead: window.paneDead,
      };
      let metadata: TmuxWindowMetadata | null = null;
      try {
        metadata = window.metadataRaw ? (JSON.parse(window.metadataRaw) as TmuxWindowMetadata) : null;
      } catch {}
      if (!metadata) continue;
      managed.push({ target, metadata });
    }
    return managed;
  }

  listProjectManagedWindows(projectRoot: string): Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> {
    const hostSession = this.getProjectSession(projectRoot).sessionName;
    const allSessionNames = this.listSessionNames();
    this.repairLegacyProjectSessionNames(projectRoot, allSessionNames);
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

  switchClient(sessionName: string, windowIndex = 0, clientTty?: string): void {
    const args = ["switch-client"];
    if (clientTty) args.push("-c", clientTty);
    args.push("-t", `${sessionName}:${windowIndex}`);
    this.interactiveExec(args);
  }

  isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.TMUX);
  }

  openTarget(target: TmuxTarget, options: OpenTargetOptions = {}): void {
    const insideTmux = options.insideTmux === true;
    const targetHostSession =
      insideTmux && this.isClientSessionName(target.sessionName)
        ? this.getSessionOption(target.sessionName, "@aimux-host-session")
        : null;
    const openSessionName = targetHostSession || target.sessionName;
    const openProjectRoot =
      insideTmux && !this.isClientSessionName(openSessionName)
        ? this.getSessionOption(openSessionName, "@aimux-project-root")
        : null;
    const shouldResolveManagedClient =
      insideTmux &&
      !this.isClientSessionName(openSessionName) &&
      (this.isManagedSessionName(openSessionName) || Boolean(openProjectRoot));
    const sessionName = shouldResolveManagedClient
      ? this.resolveOpenSessionName(openSessionName, true, options.clientSuffix, options.clientTty)
      : options.alreadyResolved
        ? openSessionName
        : this.resolveOpenSessionName(openSessionName, insideTmux, options.clientSuffix, options.clientTty);
    const effectiveTarget =
      sessionName !== target.sessionName
        ? this.ensureLinkedWindow(sessionName, target, isDashboardWindowName(target.windowName) ? 0 : undefined)
        : {
            ...target,
            sessionName,
          };
    log.info("opening tmux target", "tmux", {
      targetSession: target.sessionName,
      targetWindowId: target.windowId,
      targetWindowName: target.windowName,
      effectiveSession: effectiveTarget.sessionName,
      effectiveWindowIndex: effectiveTarget.windowIndex,
      insideTmux,
      alreadyResolved: options.alreadyResolved === true,
    });
    if (isDashboardWindowName(effectiveTarget.windowName)) {
      this.cancelCopyMode(effectiveTarget);
    }
    if (insideTmux) {
      const current = options.returnSessionName ?? this.currentClientSession();
      if (current && current !== sessionName) {
        this.setReturnSession(sessionName, current);
      }
      this.switchClient(sessionName, effectiveTarget.windowIndex, options.clientTty);
      return;
    }
    this.attachSession(sessionName, effectiveTarget.windowIndex);
  }

  private configureSession(sessionName: string, projectRoot: string): void {
    const controlScript = this.getControlScriptShellCommand();
    const statuslineCommand = this.getStatuslineCommandSpec();
    const projectStateDir = getProjectStateDirFor(projectRoot);
    const controlContextArgs = [
      "--current-client-session #{q:client_session}",
      "--client-tty #{q:client_tty}",
      "--current-window #{q:window_name}",
      "--current-window-id #{q:window_id}",
      "--current-path #{q:pane_current_path}",
      "--pane-id #{q:pane_id}",
    ].join(" ");
    const controlCommand = (action: string, args = "") =>
      `${controlScript} ${action}${args ? ` ${args}` : ""} ${controlContextArgs} >/dev/null 2>&1`;
    this.exec(["set-option", "-t", sessionName, "@aimux-project-root", projectRoot]);
    this.exec(["set-option", "-t", sessionName, "@aimux-project-state-dir", projectStateDir]);
    this.exec(["set-option", "-t", sessionName, TMUX_RUNTIME_OWNER_OPTION, getRuntimeOwnerId()]);
    this.exec(["set-option", "-t", sessionName, "prefix", MANAGED_TMUX_SESSION_OPTIONS.prefix]);
    this.exec(["set-option", "-t", sessionName, "prefix2", MANAGED_TMUX_SESSION_OPTIONS.prefix2]);
    this.exec(["set-option", "-t", sessionName, "mouse", MANAGED_TMUX_SESSION_OPTIONS.mouse]);
    this.exec(["set-option", "-t", sessionName, "window-size", MANAGED_TMUX_SESSION_OPTIONS.windowSize]);
    this.exec(["set-option", "-t", sessionName, "set-clipboard", "external"]);
    this.exec(["set-option", "-t", sessionName, "copy-command", "pbcopy"]);
    this.exec(["set-option", "-t", sessionName, "repeat-time", "300"]);
    this.exec(["set-option", "-t", sessionName, "focus-events", "on"]);
    this.exec(["set-hook", "-t", sessionName, "pane-focus-in", `run-shell -b ${shellQuote(controlCommand("active"))}`]);
    this.exec(["set-option", "-t", sessionName, "bell-action", "none"]);
    this.exec(["set-window-option", "-t", sessionName, "monitor-bell", "off"]);
    this.exec([
      "set-window-option",
      "-t",
      sessionName,
      "aggressive-resize",
      MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressiveResize,
    ]);
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
    this.applyDefaultRootMouseBindings();
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
    this.exec(["unbind-key", "-T", "prefix", "s"]);
    this.exec(["unbind-key", "-T", "prefix", "n"]);
    this.exec(["unbind-key", "-T", "prefix", "p"]);
    this.exec(["unbind-key", "-T", "prefix", "d"]);
    this.exec(["unbind-key", "-T", "prefix", "u"]);
    this.exec(["unbind-key", "-T", "prefix", "e"]);
    this.exec(["unbind-key", "-T", "prefix", "g"]);
    this.exec(["unbind-key", "-T", "prefix", "m"]);
    this.exec(["unbind-key", "-T", "prefix", "K"]);
    for (const digit of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      this.exec(["unbind-key", "-T", "prefix", digit]);
    }
    this.exec(["unbind-key", "-T", "prefix", "Any"]);
    this.exec(["bind-key", "-T", "prefix", "C-a", "send-prefix"]);
    this.exec(["bind-key", "-T", "prefix", "0", "run-shell", "-b", "true"]);
    for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      this.exec(["bind-key", "-T", "prefix", digit, "run-shell", "-b", controlCommand("window", `--index ${digit}`)]);
    }
    this.exec(["bind-key", "-r", "-T", "prefix", "n", "run-shell", "-b", controlCommand("next")]);
    this.exec(["bind-key", "-r", "-T", "prefix", "p", "run-shell", "-b", controlCommand("prev")]);
    this.exec(["bind-key", "-T", "prefix", "s", "run-shell", "-b", controlCommand("menu")]);
    this.exec(["bind-key", "-T", "prefix", "u", "run-shell", "-b", controlCommand("attention")]);
    const metaHomeArg = process.env.AIMUX_HOME ? ` --aimux-home ${shellQuote(process.env.AIMUX_HOME)}` : "";
    this.exec(["bind-key", "-T", "prefix", "g", "run-shell", "-b", controlCommand("expose", metaHomeArg.trim())]);
    this.exec(["bind-key", "-T", "prefix", "m", "run-shell", "-b", controlCommand("meta", metaHomeArg.trim())]);
    this.exec(["bind-key", "-T", "prefix", "e", "run-shell", "-b", controlCommand("team")]);
    this.exec(["bind-key", "-T", "prefix", "d", "run-shell", "-b", controlCommand("dashboard")]);
    this.exec(["bind-key", "-T", "prefix", "i", "run-shell", "-b", controlCommand("inbox")]);
    this.exec(["bind-key", "-T", "prefix", "K", "clear-history", "\\;", "send-keys", "C-l"]);
    this.exec(["bind-key", "-T", "prefix", "L", "clear-history", "\\;", "send-keys", "C-l"]);
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
    // Single-color status-bar band: one uniform colour236 behind both the status
    // and tab rows (distinct from the pane above), set via status-style so it
    // fills full width without per-row shade seams.
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
      `#[bg=colour236,fg=colour255,bold] #(${top})#[default]#{?pane_in_mode, #[fg=colour214,bold]scroll#[default],}`,
    ]);
    this.exec([
      "set-option",
      "-t",
      sessionName,
      "status-format[1]",
      `#[bg=colour236,fg=colour252] #(${bottom}) #[default]`,
    ]);
  }

  private setCurrentRuntimeContract(sessionName: string): void {
    this.exec(["set-option", "-t", sessionName, TMUX_RUNTIME_CONTRACT_OPTION, AIMUX_TMUX_RUNTIME_CONTRACT_VERSION]);
  }

  private applyDefaultRootMouseBindings(): void {
    const dir = mkdtempSync(join(tmpdir(), "aimux-tmux-"));
    const file = join(dir, "mouse-bindings.conf");
    const openHyperlinkScript = fileURLToPath(new URL("../../scripts/tmux-open-hyperlink.sh", import.meta.url));
    const projectStateDir = getProjectStateDirFor(process.cwd());
    try {
      const openPaneLinkCommand = `AIMUX_HYPERLINK=#{q:mouse_hyperlink} AIMUX_MOUSE_WORD=#{q:mouse_word} AIMUX_MOUSE_LINE=#{q:mouse_line} sh ${shellQuote(openHyperlinkScript)} >/dev/null 2>&1`;
      const openStatusPrCommand = `AIMUX_STATUS_LINE=#{q:mouse_status_line} AIMUX_PROJECT_STATE_DIR=${shellQuote(projectStateDir)} AIMUX_CURRENT_WINDOW_ID=#{q:window_id} sh ${shellQuote(openHyperlinkScript)} >/dev/null 2>&1`;
      writeFileSync(file, buildDefaultRootMouseBindingsConfig({ openPaneLinkCommand, openStatusPrCommand }), "utf8");
      this.exec(["source-file", file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  private resolveOpenSessionName(
    sessionName: string,
    insideTmux: boolean,
    suffixOverride?: string,
    clientTty?: string,
  ): string {
    if (this.isClientSessionName(sessionName)) return sessionName;
    const managed = this.isManagedSessionName(sessionName);
    const projectRoot = managed || insideTmux ? this.getSessionOption(sessionName, "@aimux-project-root") : null;
    if (!managed && !projectRoot) return sessionName;
    const clientSuffix = suffixOverride ?? this.resolveClientSuffix(insideTmux, clientTty);
    if (!clientSuffix) return sessionName;
    const clientSessionName = this.getProjectClientSessionName(sessionName, clientSuffix);
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

  private resolveClientSuffix(insideTmux: boolean, clientTtyOverride?: string): string | null {
    const override = process.env.AIMUX_CLIENT_KEY?.trim();
    if (override) return this.normalizeClientSuffix(override);
    if (insideTmux) {
      // Prefer the real client's tty (passed explicitly) over the ambient
      // client, which from inside a display-popup would be the popup's own.
      if (clientTtyOverride) return this.normalizeClientSuffix(clientTtyOverride);
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
    const scriptPath = fileURLToPath(new URL("../../scripts/tmux-statusline.sh", import.meta.url));
    statSync(scriptPath);
    return {
      cwd: process.cwd(),
      command: "sh",
      args: [scriptPath],
    };
  }

  private getControlScriptShellCommand(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const scriptPath = join(dirname(currentFile), "..", "..", "scripts", "tmux-control.sh");
    return `sh ${shellQuote(scriptPath)}`;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
