import * as net from "node:net";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PtySession } from "./pty-session.js";
import { registerInstance, unregisterInstance, updateHeartbeat, type InstanceSessionRef } from "./instance-registry.js";
import { debug } from "./debug.js";
import { getProjectStateDir, getStatePath } from "./paths.js";

interface SavedSessionState {
  id: string;
  tool: string;
  toolConfigKey: string;
  command: string;
  args: string[];
  backendSessionId?: string;
  worktreePath?: string;
  label?: string;
}

interface ServerSessionRecord {
  pty: PtySession;
  state: SavedSessionState;
}

export function getPidPath(): string {
  return join(getProjectStateDir(), "aimux.pid");
}

export function getSocketPath(): string {
  return join(getProjectStateDir(), "aimux.sock");
}

/** Check if a server is already running */
export function isServerRunning(): boolean {
  const pidPath = getPidPath();
  const socketPath = getSocketPath();
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {}
    try {
      unlinkSync(socketPath);
    } catch {}
    return false;
  }
}

/** Get server status info */
export function getServerStatus(): { running: boolean; pid?: number } {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return { running: false };
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/** Stop a running server by sending SIGTERM */
export function stopServer(): boolean {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// ── Protocol types ─────────────────────────────────────────────────

interface SpawnMsg {
  type: "spawn";
  id: string;
  command: string;
  args: string[];
  toolConfigKey?: string;
  backendSessionId?: string;
  worktreePath?: string;
  label?: string;
  cwd?: string;
  cols: number;
  rows: number;
}
interface WriteMsg {
  type: "write";
  id: string;
  data: string; // base64
}
interface ResizeMsg {
  type: "resize";
  id: string;
  cols: number;
  rows: number;
}
interface ScreenMsg {
  type: "screen";
  id: string;
}
interface KillMsg {
  type: "kill";
  id: string;
}
interface RenameMsg {
  type: "rename";
  id: string;
  label?: string;
}
interface ListMsg {
  type: "list";
}

type ClientMessage = SpawnMsg | WriteMsg | ResizeMsg | ScreenMsg | KillMsg | RenameMsg | ListMsg;

// ── Server ─────────────────────────────────────────────────────────

export class AimuxServer {
  private sessions = new Map<string, ServerSessionRecord>();
  private clients = new Set<net.Socket>();
  private socketServer: net.Server | null = null;
  private skipPersistOnExit = new Set<string>();
  private shuttingDown = false;
  private instanceId = `server-${Math.random().toString(36).slice(2, 8)}`;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  async start(): Promise<void> {
    const projectDir = getProjectStateDir();
    const pidPath = getPidPath();
    const socketPath = getSocketPath();
    mkdirSync(projectDir, { recursive: true });

    if (isServerRunning()) {
      throw new Error("Server is already running");
    }

    // Clean up stale socket
    try {
      unlinkSync(socketPath);
    } catch {}

    writeFileSync(pidPath, String(process.pid));
    debug(`server started (PID ${process.pid})`, "server");

    // Register in instance registry
    await registerInstance(this.instanceId, this.cwd);

    // Heartbeat
    this.heartbeatInterval = setInterval(() => {
      const refs = this.getSessionRefs();
      updateHeartbeat(this.instanceId, refs, this.cwd).catch(() => {});
    }, 5000);

    // Start Unix socket server
    this.socketServer = net.createServer((client) => this.handleClient(client));
    this.socketServer.listen(socketPath, () => {
      debug(`socket listening at ${socketPath}`, "server");
    });

    // Signal handlers
    const cleanup = () => this.shutdown();
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    // Keep alive
    await new Promise<void>(() => {});
  }

  private handleClient(client: net.Socket): void {
    this.clients.add(client);
    debug(`client connected (${this.clients.size} total)`, "server");

    let buffer = "";

    client.on("data", (chunk) => {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim()) {
          try {
            const msg = JSON.parse(line) as ClientMessage;
            this.handleMessage(client, msg);
          } catch (err) {
            this.send(client, { type: "error", message: `Invalid message: ${err}` });
          }
        }
      }
    });

    client.on("close", () => {
      this.clients.delete(client);
      debug(`client disconnected (${this.clients.size} remaining)`, "server");
    });

    client.on("error", () => {
      this.clients.delete(client);
    });
  }

  private handleMessage(client: net.Socket, msg: ClientMessage): void {
    switch (msg.type) {
      case "spawn":
        this.handleSpawn(client, msg);
        break;
      case "write":
        this.handleWrite(msg);
        break;
      case "resize":
        this.handleResize(msg);
        break;
      case "screen":
        this.handleScreen(client, msg);
        break;
      case "kill":
        this.handleKill(msg);
        break;
      case "rename":
        this.handleRename(client, msg);
        break;
      case "list":
        this.handleList(client);
        break;
    }
  }

  private handleSpawn(client: net.Socket, msg: SpawnMsg): void {
    if (this.sessions.has(msg.id)) {
      this.send(client, { type: "error", message: `Session ${msg.id} already exists` });
      return;
    }

    try {
      const session = new PtySession({
        command: msg.command,
        args: msg.args,
        cols: msg.cols,
        rows: msg.rows,
        cwd: msg.cwd ?? this.cwd,
        id: msg.id,
      });
      session.backendSessionId = msg.backendSessionId;

      const record: ServerSessionRecord = {
        pty: session,
        state: {
          id: msg.id,
          tool: msg.command,
          toolConfigKey: msg.toolConfigKey ?? msg.command,
          command: msg.command,
          args: [...msg.args],
          backendSessionId: msg.backendSessionId,
          worktreePath: msg.worktreePath,
          label: msg.label,
        },
      };

      // Broadcast PTY output to all connected clients
      session.onData((data) => {
        const payload = { type: "data", id: session.id, data: Buffer.from(data).toString("base64") };
        this.broadcast(payload);
      });

      session.onExit((code) => {
        debug(`session exited: ${session.id} (code=${code})`, "server");
        const shouldPersist = !this.shuttingDown && !this.skipPersistOnExit.has(session.id);
        this.skipPersistOnExit.delete(session.id);
        if (shouldPersist) {
          this.persistSessionState(record.state);
        }
        this.broadcast({ type: "exit", id: session.id, code });
        this.sessions.delete(session.id);
      });

      this.sessions.set(session.id, record);
      debug(`spawned session: ${session.id} (${msg.command})`, "server");
      this.send(client, { type: "spawned", id: session.id });
    } catch (err) {
      this.send(client, {
        type: "spawn_failed",
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleWrite(msg: WriteMsg): void {
    const record = this.sessions.get(msg.id);
    if (record) {
      record.pty.write(Buffer.from(msg.data, "base64").toString());
    }
  }

  private handleResize(msg: ResizeMsg): void {
    const record = this.sessions.get(msg.id);
    if (record) {
      record.pty.resize(msg.cols, msg.rows);
    }
  }

  private handleScreen(client: net.Socket, msg: ScreenMsg): void {
    const record = this.sessions.get(msg.id);
    if (record) {
      const screen = record.pty.getScreenState();
      this.send(client, { type: "screen", id: msg.id, data: Buffer.from(screen).toString("base64") });
    } else {
      this.send(client, { type: "error", message: `Session ${msg.id} not found` });
    }
  }

  private handleKill(msg: KillMsg): void {
    const record = this.sessions.get(msg.id);
    if (record) {
      this.skipPersistOnExit.add(msg.id);
      record.pty.destroy();
      this.sessions.delete(msg.id);
      debug(`killed session: ${msg.id}`, "server");
    }
  }

  private handleRename(client: net.Socket, msg: RenameMsg): void {
    const record = this.sessions.get(msg.id);
    if (!record) {
      this.send(client, { type: "error", message: `Session ${msg.id} not found` });
      return;
    }

    const label = msg.label?.trim();
    if (label) {
      record.state.label = label;
    } else {
      delete record.state.label;
    }

    this.persistSessionState(record.state);
    this.broadcast({ type: "session_updated", id: msg.id, label: record.state.label });
  }

  private handleList(client: net.Socket): void {
    const sessions = [...this.sessions.values()].map(({ pty, state }) => ({
      id: pty.id,
      command: pty.command,
      status: pty.status,
      exited: pty.exited,
      toolConfigKey: state.toolConfigKey,
      backendSessionId: state.backendSessionId,
      worktreePath: state.worktreePath,
      label: state.label,
    }));
    this.send(client, { type: "sessions", sessions });
  }

  private send(client: net.Socket, data: Record<string, unknown>): void {
    try {
      client.write(JSON.stringify(data) + "\n");
    } catch {}
  }

  private broadcast(data: Record<string, unknown>): void {
    const line = JSON.stringify(data) + "\n";
    for (const client of this.clients) {
      try {
        client.write(line);
      } catch {}
    }
  }

  private getSessionRefs(): InstanceSessionRef[] {
    return [...this.sessions.values()].map(({ pty, state }) => ({
      id: pty.id,
      tool: pty.command,
      backendSessionId: state.backendSessionId,
      worktreePath: state.worktreePath,
    }));
  }

  private shutdown(): void {
    debug("server shutting down", "server");
    this.shuttingDown = true;

    // Save state (same format as TUI exit) so sessions appear as offline/resumable
    this.saveState();

    // Kill all sessions
    for (const session of this.sessions.values()) {
      session.pty.destroy();
    }
    this.sessions.clear();

    // Close clients
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    // Stop socket server
    if (this.socketServer) {
      this.socketServer.close();
      this.socketServer = null;
    }

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Unregister
    unregisterInstance(this.instanceId, this.cwd).catch(() => {});

    // Clean up files
    const pidPath = getPidPath();
    const socketPath = getSocketPath();
    try {
      unlinkSync(pidPath);
    } catch {}
    try {
      unlinkSync(socketPath);
    } catch {}

    process.exit(0);
  }

  private saveState(): void {
    if (this.sessions.size === 0) return;

    try {
      const currentSessions = [...this.sessions.values()].map(({ state }) => state);
      this.persistSessionsState(currentSessions);
      debug(`saved ${this.sessions.size} session(s) to state.json`, "server");
    } catch (err) {
      debug(`failed to save state: ${err}`, "server");
    }
  }

  private persistSessionState(session: SavedSessionState): void {
    this.persistSessionsState([session]);
  }

  private persistSessionsState(sessions: SavedSessionState[]): void {
    if (sessions.length === 0) return;

    const normalized = sessions.map((session) => ({
      ...session,
      toolConfigKey: session.toolConfigKey || session.command,
      args: Array.isArray(session.args) ? [...session.args] : [],
    }));

    const statePath = getStatePath();

    let state: { savedAt: string; cwd: string; sessions: SavedSessionState[] } = {
      savedAt: new Date().toISOString(),
      cwd: this.cwd,
      sessions: [],
    };
    if (existsSync(statePath)) {
      try {
        state = JSON.parse(readFileSync(statePath, "utf-8"));
      } catch {}
    }

    const incomingIds = new Set(normalized.map((session) => session.id));
    const incomingBackendIds = new Set(normalized.map((session) => session.backendSessionId).filter(Boolean));
    const retainedSessions = state.sessions.filter((session) => {
      if (incomingIds.has(session.id)) return false;
      if (session.backendSessionId && incomingBackendIds.has(session.backendSessionId)) return false;
      return true;
    });

    state.sessions = [...retainedSessions, ...normalized];
    state.savedAt = new Date().toISOString();
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  }
}

/** Start the server in foreground mode */
export async function startServerForeground(): Promise<void> {
  const { initPaths } = await import("./paths.js");
  await initPaths();

  const server = new AimuxServer();
  await server.start();
}
