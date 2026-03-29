import * as net from "node:net";
import { existsSync } from "node:fs";
import { StatusDetector, type SessionStatus } from "./status-detector.js";
import { getSocketPath } from "./server.js";
import { debug } from "./debug.js";
import stripAnsi from "strip-ansi";
import {
  SessionTerminalState,
  type SessionTerminalDebugState,
  type SessionTerminalSnapshot,
} from "./session-terminal-state.js";

export { type SessionStatus } from "./status-detector.js";

/**
 * A session proxy that communicates with the server over a Unix socket.
 * Matches PtySession's interface so the multiplexer can use it interchangeably.
 */
export class ServerSession {
  readonly id: string;
  readonly command: string;
  backendSessionId?: string;

  private _exited = false;
  private _exitCode: number | undefined;
  private statusDetector: StatusDetector;
  private terminalState: SessionTerminalState;
  private client: ServerClient;

  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  constructor(
    id: string,
    command: string,
    client: ServerClient,
    cols: number,
    rows: number,
    promptPatterns?: RegExp[],
  ) {
    this.id = id;
    this.command = command;
    this.client = client;
    this.statusDetector = new StatusDetector(promptPatterns);
    this.terminalState = new SessionTerminalState(cols, rows);
  }

  /** Called by ServerClient when data arrives for this session */
  _receiveData(data: string): void {
    this.terminalState.write(data);
    this.statusDetector.feed(stripAnsi(data));
    for (const cb of this.dataListeners) cb(data);
  }

  /** Called by ServerClient when this session exits */
  _receiveExit(code: number): void {
    this._exited = true;
    this._exitCode = code;
    this.statusDetector.markExited();
    for (const cb of this.exitListeners) cb(code);
  }

  /** Rebuild the local VT mirror from a server-provided screen snapshot. */
  _hydrateScreen(screen: string): void {
    this.terminalState.write(screen);
    this.statusDetector.feed(stripAnsi(screen));
  }

  async _hydrateSnapshot(snapshot: SessionTerminalSnapshot): Promise<void> {
    await this.terminalState.hydrateSnapshot(snapshot);
    this.statusDetector.feed(stripAnsi(this.terminalState.getScreenState()));
  }

  get exited(): boolean {
    return this._exited;
  }

  get exitCode(): number | undefined {
    return this._exitCode;
  }

  get status(): SessionStatus {
    return this.statusDetector.status;
  }

  write(data: string): void {
    if (!this._exited) {
      this.client.send({
        type: "write",
        id: this.id,
        data: Buffer.from(data).toString("base64"),
      });
    }
  }

  resize(cols: number, rows: number): void {
    if (!this._exited) {
      this.client.send({ type: "resize", id: this.id, cols, rows });
    }
    this.terminalState.resize(cols, rows);
  }

  /** Reconstruct screen from local vt mirror (same as PtySession.getScreenState) */
  getScreenState(): string {
    return this.terminalState.getScreenState();
  }

  getCursorPosition(): { row: number; col: number } {
    return this.terminalState.getCursorPosition();
  }

  getDebugState(): SessionTerminalDebugState {
    return this.terminalState.getDebugState();
  }

  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    this.exitListeners.push(cb);
  }

  kill(): void {
    this.client.send({ type: "kill", id: this.id });
  }

  destroy(): void {
    this.statusDetector.destroy();
    this.terminalState.dispose();
    this.kill();
  }
}

/**
 * Client that connects to the aimux server via Unix socket.
 * Manages ServerSession instances and routes messages.
 */
export class ServerClient {
  private socket: net.Socket | null = null;
  private sessions = new Map<string, ServerSession>();
  private buffer = "";
  private pendingCallbacks = new Map<string, (data: any) => void>();
  private _connected = false;
  private sessionUpdateListeners: Array<(update: { id: string; label?: string }) => void> = [];

  get connected(): boolean {
    return this._connected;
  }

  /** Check if the server socket exists (quick check, no connect) */
  static isAvailable(): boolean {
    return existsSync(getSocketPath());
  }

  /** Connect to the server socket */
  async connect(): Promise<void> {
    const sockPath = getSocketPath();
    if (!existsSync(sockPath)) {
      throw new Error("Server socket not found");
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(sockPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Connection timeout"));
      }, 3000);

      socket.on("connect", () => {
        clearTimeout(timeout);
        this.socket = socket;
        this._connected = true;
        debug("connected to server", "server-client");
        this.setupListeners();
        resolve();
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupListeners(): void {
    if (!this.socket) return;

    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line.trim()) {
          try {
            this.handleMessage(JSON.parse(line));
          } catch {}
        }
      }
    });

    this.socket.on("close", () => {
      this._connected = false;
      debug("disconnected from server", "server-client");
      // Mark all sessions as exited
      for (const session of this.sessions.values()) {
        if (!session.exited) {
          session._receiveExit(-1);
        }
      }
    });

    this.socket.on("error", () => {
      this._connected = false;
    });
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case "data": {
        const session = this.sessions.get(msg.id);
        if (session) {
          session._receiveData(Buffer.from(msg.data, "base64").toString());
        }
        break;
      }
      case "exit": {
        const session = this.sessions.get(msg.id);
        if (session) {
          session._receiveExit(msg.code ?? 0);
          this.sessions.delete(msg.id);
        }
        break;
      }
      case "screen": {
        const cb = this.pendingCallbacks.get(`screen:${msg.id}`);
        if (cb) {
          this.pendingCallbacks.delete(`screen:${msg.id}`);
          cb(JSON.parse(Buffer.from(msg.data, "base64").toString()));
        }
        break;
      }
      case "sessions": {
        const cb = this.pendingCallbacks.get("list");
        if (cb) {
          this.pendingCallbacks.delete("list");
          cb(msg.sessions);
        }
        break;
      }
      case "session_updated": {
        const label = typeof msg.label === "string" ? msg.label : undefined;
        for (const cb of this.sessionUpdateListeners) {
          cb({ id: msg.id, label });
        }
        const pending = this.pendingCallbacks.get(`rename:${msg.id}`);
        if (pending) {
          this.pendingCallbacks.delete(`rename:${msg.id}`);
          pending(true);
        }
        break;
      }
      case "spawned": {
        const cb = this.pendingCallbacks.get(`spawn:${msg.id}`);
        if (cb) {
          this.pendingCallbacks.delete(`spawn:${msg.id}`);
          cb(true);
        }
        break;
      }
      case "spawn_failed": {
        const session = this.sessions.get(msg.id);
        if (session && !session.exited) {
          session._receiveExit(-1);
          this.sessions.delete(msg.id);
        }
        const cb = this.pendingCallbacks.get(`spawn:${msg.id}`);
        if (cb) {
          this.pendingCallbacks.delete(`spawn:${msg.id}`);
          cb(false);
        }
        debug(`server spawn failed for ${msg.id}: ${msg.message}`, "server-client");
        break;
      }
      case "error": {
        debug(`server error: ${msg.message}`, "server-client");
        break;
      }
    }
  }

  /** Send a message to the server */
  send(msg: Record<string, unknown>): void {
    if (this.socket && this._connected) {
      this.socket.write(JSON.stringify(msg) + "\n");
    }
  }

  /** Spawn a session on the server */
  async spawn(opts: {
    id: string;
    command: string;
    args: string[];
    cwd?: string;
    cols: number;
    rows: number;
    promptPatterns?: RegExp[];
  }): Promise<ServerSession> {
    const session = new ServerSession(opts.id, opts.command, this, opts.cols, opts.rows, opts.promptPatterns);
    this.sessions.set(opts.id, session);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(`spawn:${opts.id}`);
        this.sessions.delete(opts.id);
        reject(new Error("Spawn timeout"));
      }, 10_000);

      this.pendingCallbacks.set(`spawn:${opts.id}`, () => {
        clearTimeout(timeout);
        resolve(session);
      });

      this.send({
        type: "spawn",
        id: opts.id,
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
      });
    });
  }

  /** Request screen state for a session (async, waits for server response) */
  async requestScreen(id: string): Promise<SessionTerminalSnapshot> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(`screen:${id}`);
        resolve({
          cols: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
          cursor: { row: 1, col: 1 },
          viewportY: 0,
          baseY: 0,
          startLine: 0,
          lines: [],
        });
      }, 3000);

      this.pendingCallbacks.set(`screen:${id}`, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });

      this.send({ type: "screen", id });
    });
  }

  /** List live sessions on the server */
  async listSessions(): Promise<
    Array<{
      id: string;
      command: string;
      status: string;
      exited?: boolean;
      toolConfigKey?: string;
      backendSessionId?: string;
      worktreePath?: string;
      label?: string;
    }>
  > {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete("list");
        resolve([]);
      }, 3000);

      this.pendingCallbacks.set("list", (sessions) => {
        clearTimeout(timeout);
        resolve(sessions);
      });

      this.send({ type: "list" });
    });
  }

  /** Get a tracked session by ID */
  getSession(id: string): ServerSession | undefined {
    return this.sessions.get(id);
  }

  onSessionUpdated(cb: (update: { id: string; label?: string }) => void): void {
    this.sessionUpdateListeners.push(cb);
  }

  async renameSession(id: string, label?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(`rename:${id}`);
        resolve(false);
      }, 3000);

      this.pendingCallbacks.set(`rename:${id}`, (ok) => {
        clearTimeout(timeout);
        resolve(Boolean(ok));
      });

      this.send({ type: "rename", id, label });
    });
  }

  /** Register an existing server session (for reconnection) */
  registerSession(id: string, command: string, cols: number, rows: number, promptPatterns?: RegExp[]): ServerSession {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const session = new ServerSession(id, command, this, cols, rows, promptPatterns);
    this.sessions.set(id, session);
    return session;
  }

  /** Disconnect from server (sessions keep running on server) */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._connected = false;
    this.sessions.clear();
    this.pendingCallbacks.clear();
  }
}
