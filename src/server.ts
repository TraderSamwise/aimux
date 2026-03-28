import * as net from "node:net";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PtySession } from "./pty-session.js";
import { registerInstance, unregisterInstance, updateHeartbeat, type InstanceSessionRef } from "./instance-registry.js";
import { debug } from "./debug.js";

const AIMUX_DIR = join(homedir(), ".aimux");
const PID_PATH = join(AIMUX_DIR, "aimux.pid");
const SOCK_PATH = join(AIMUX_DIR, "aimux.sock");

export function getPidPath(): string {
  return PID_PATH;
}

export function getSocketPath(): string {
  return SOCK_PATH;
}

/** Check if a server is already running */
export function isServerRunning(): boolean {
  if (!existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      unlinkSync(PID_PATH);
    } catch {}
    try {
      unlinkSync(SOCK_PATH);
    } catch {}
    return false;
  }
}

/** Get server status info */
export function getServerStatus(): { running: boolean; pid?: number } {
  if (!existsSync(PID_PATH)) return { running: false };
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/** Stop a running server by sending SIGTERM */
export function stopServer(): boolean {
  if (!existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
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
interface ListMsg {
  type: "list";
}

type ClientMessage = SpawnMsg | WriteMsg | ResizeMsg | ScreenMsg | KillMsg | ListMsg;

// ── Server ─────────────────────────────────────────────────────────

export class AimuxServer {
  private sessions = new Map<string, PtySession>();
  private clients = new Set<net.Socket>();
  private socketServer: net.Server | null = null;
  private instanceId = `server-${Math.random().toString(36).slice(2, 8)}`;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private cwd: string;
  private _paths: { getStatePath: () => string } | null = null;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  async start(): Promise<void> {
    mkdirSync(AIMUX_DIR, { recursive: true });

    if (isServerRunning()) {
      throw new Error("Server is already running");
    }

    // Clean up stale socket
    try {
      unlinkSync(SOCK_PATH);
    } catch {}

    writeFileSync(PID_PATH, String(process.pid));
    debug(`server started (PID ${process.pid})`, "server");

    // Cache paths module for saveState
    try {
      this._paths = await importPaths();
    } catch {}

    // Register in instance registry
    await registerInstance(this.instanceId, this.cwd);

    // Heartbeat
    this.heartbeatInterval = setInterval(() => {
      const refs = this.getSessionRefs();
      updateHeartbeat(this.instanceId, refs, this.cwd).catch(() => {});
    }, 5000);

    // Start Unix socket server
    this.socketServer = net.createServer((client) => this.handleClient(client));
    this.socketServer.listen(SOCK_PATH, () => {
      debug(`socket listening at ${SOCK_PATH}`, "server");
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

      // Broadcast PTY output to all connected clients
      session.onData((data) => {
        const payload = { type: "data", id: session.id, data: Buffer.from(data).toString("base64") };
        this.broadcast(payload);
      });

      session.onExit((code) => {
        debug(`session exited: ${session.id} (code=${code})`, "server");
        this.broadcast({ type: "exit", id: session.id, code });
        this.sessions.delete(session.id);
      });

      this.sessions.set(session.id, session);
      debug(`spawned session: ${session.id} (${msg.command})`, "server");
      this.send(client, { type: "spawned", id: session.id });
    } catch (err) {
      this.send(client, { type: "error", message: `Spawn failed: ${err}` });
    }
  }

  private handleWrite(msg: WriteMsg): void {
    const session = this.sessions.get(msg.id);
    if (session) {
      session.write(Buffer.from(msg.data, "base64").toString());
    }
  }

  private handleResize(msg: ResizeMsg): void {
    const session = this.sessions.get(msg.id);
    if (session) {
      session.resize(msg.cols, msg.rows);
    }
  }

  private handleScreen(client: net.Socket, msg: ScreenMsg): void {
    const session = this.sessions.get(msg.id);
    if (session) {
      const screen = session.getScreenState();
      this.send(client, { type: "screen", id: msg.id, data: Buffer.from(screen).toString("base64") });
    } else {
      this.send(client, { type: "error", message: `Session ${msg.id} not found` });
    }
  }

  private handleKill(msg: KillMsg): void {
    const session = this.sessions.get(msg.id);
    if (session) {
      session.destroy();
      this.sessions.delete(msg.id);
      debug(`killed session: ${msg.id}`, "server");
    }
  }

  private handleList(client: net.Socket): void {
    const sessions = [...this.sessions.values()].map((s) => ({
      id: s.id,
      command: s.command,
      status: s.status,
      exited: s.exited,
      backendSessionId: s.backendSessionId,
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
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      tool: s.command,
      backendSessionId: s.backendSessionId,
    }));
  }

  private shutdown(): void {
    debug("server shutting down", "server");

    // Save state (same format as TUI exit) so sessions appear as offline/resumable
    this.saveState();

    // Kill all sessions
    for (const session of this.sessions.values()) {
      session.destroy();
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
    try {
      unlinkSync(PID_PATH);
    } catch {}
    try {
      unlinkSync(SOCK_PATH);
    } catch {}

    process.exit(0);
  }

  private saveState(): void {
    if (this.sessions.size === 0) return;

    try {
      const { getStatePath } = this._paths ?? {};
      if (!getStatePath) return;
      const statePath = getStatePath();

      // Read existing state and merge
      let state: { savedAt: string; cwd: string; sessions: any[] } = {
        savedAt: new Date().toISOString(),
        cwd: this.cwd,
        sessions: [],
      };
      if (existsSync(statePath)) {
        try {
          state = JSON.parse(readFileSync(statePath, "utf-8"));
        } catch {}
      }

      const existingIds = new Set(state.sessions.map((s: any) => s.id));
      for (const session of this.sessions.values()) {
        if (!existingIds.has(session.id)) {
          state.sessions.push({
            id: session.id,
            tool: session.command,
            command: session.command,
            backendSessionId: session.backendSessionId,
          });
        }
      }

      state.savedAt = new Date().toISOString();
      mkdirSync(join(statePath, ".."), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      debug(`saved ${this.sessions.size} session(s) to state.json`, "server");
    } catch (err) {
      debug(`failed to save state: ${err}`, "server");
    }
  }
}

// Lazy import to avoid circular dependency with paths.ts at module load
async function importPaths() {
  return import("./paths.js");
}

/** Start the server in foreground mode */
export async function startServerForeground(): Promise<void> {
  const { initPaths } = await importPaths();
  await initPaths();

  const server = new AimuxServer();
  await server.start();
}
