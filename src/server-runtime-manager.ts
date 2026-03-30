import { debug } from "./debug.js";
import { ServerClient, type ServerSession } from "./server-client.js";
import type { SessionRuntime } from "./session-runtime.js";

export interface ServerSessionInfo {
  id: string;
  command: string;
  toolConfigKey?: string;
  backendSessionId?: string;
  worktreePath?: string;
  label?: string;
  exited?: boolean;
}

export interface ServerRuntimeReconnectHooks {
  resolvePromptPatterns: (command: string) => RegExp[] | undefined;
  onDiscovered: (info: ServerSessionInfo, session: ServerSession) => SessionRuntime;
}

export interface ServerSpawnRequest {
  id: string;
  command: string;
  args: string[];
  toolConfigKey: string;
  backendSessionId?: string;
  worktreePath?: string;
  cwd: string;
  cols: number;
  rows: number;
  promptPatterns?: RegExp[];
}

export type ServerRuntimeEvent =
  | { type: "sessionUpdated"; id: string; label?: string }
  | { type: "sessionDiscovered"; info: ServerSessionInfo; runtime: SessionRuntime }
  | { type: "sessionHydrated"; runtime: SessionRuntime };

export interface ServerRuntimeManagerHooks {
  onEvent?: (event: ServerRuntimeEvent) => void;
}

export interface ServerRuntimeClient {
  readonly connected: boolean;
  connect(): Promise<void>;
  onSessionUpdated(cb: (update: { id: string; label?: string }) => void): void;
  listSessions(): Promise<ServerSessionInfo[]>;
  registerSession(id: string, command: string, cols: number, rows: number, promptPatterns?: RegExp[]): ServerSession;
  requestScreen(id: string): Promise<{
    cols: number;
    rows: number;
    cursor: { row: number; col: number };
    viewportY: number;
    baseY: number;
    startLine: number;
    lines: unknown[];
  }>;
  renameSession(id: string, label?: string): Promise<boolean>;
  send(msg: any): void;
  disconnect(): void;
}

export class ServerRuntimeManager {
  private client: ServerRuntimeClient | null = null;
  private readonly serverSessionIds = new Set<string>();
  private readonly backendSessionIds = new Set<string>();
  private readonly hydratingSessionIds = new Set<string>();
  private readonly runtimes = new Map<string, SessionRuntime>();

  constructor(
    private readonly createClient: () => ServerRuntimeClient = () => new ServerClient(),
    private readonly isAvailable: () => boolean = () => ServerClient.isAvailable(),
    private readonly hooks: ServerRuntimeManagerHooks = {},
  ) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  isServerSession(sessionId: string): boolean {
    return this.serverSessionIds.has(sessionId);
  }

  isHydrating(sessionId: string): boolean {
    return this.hydratingSessionIds.has(sessionId);
  }

  getRuntime(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  getSessionIds(): Set<string> {
    return new Set(this.serverSessionIds);
  }

  getBackendSessionIds(): Set<string> {
    return new Set(this.backendSessionIds);
  }

  getPersistableSessions<T extends { id: string }>(sessions: T[]): T[] {
    return sessions.filter((session) => !this.serverSessionIds.has(session.id));
  }

  getDestroyableSessions<T extends { id: string }>(sessions: T[]): T[] {
    return sessions.filter((session) => !this.serverSessionIds.has(session.id));
  }

  getOwnedBackendSessionIdsForSessions<T extends { id: string; backendSessionId?: string }>(
    sessions: T[],
  ): Set<string> {
    const owned = new Set(this.backendSessionIds);
    for (const session of sessions) {
      if (this.serverSessionIds.has(session.id)) continue;
      if (session.backendSessionId) owned.add(session.backendSessionId);
    }
    return owned;
  }

  attachRuntime(sessionId: string, runtime: SessionRuntime): void {
    if (this.serverSessionIds.has(sessionId)) {
      this.runtimes.set(sessionId, runtime);
      if (runtime.backendSessionId) this.backendSessionIds.add(runtime.backendSessionId);
    }
  }

  async connect(): Promise<void> {
    if (!this.isAvailable()) return;
    const client = this.createClient();
    await client.connect();
    client.onSessionUpdated((update) => {
      this.hooks.onEvent?.({ type: "sessionUpdated", ...update });
    });
    this.client = client;
    debug("connected to aimux server", "server-client");
  }

  async reconnectExistingSessions(cols: number, rows: number, hooks: ServerRuntimeReconnectHooks): Promise<void> {
    if (!this.client) return;
    const serverSessions = await this.client.listSessions();
    for (const info of serverSessions) {
      if (info.exited) continue;
      const promptPatterns = hooks.resolvePromptPatterns(info.command);
      const session = this.client.registerSession(info.id, info.command, cols, rows, promptPatterns);
      session.backendSessionId = info.backendSessionId;
      this.serverSessionIds.add(info.id);
      if (info.backendSessionId) this.backendSessionIds.add(info.backendSessionId);
      const runtime = hooks.onDiscovered(info, session);
      this.runtimes.set(info.id, runtime);
      this.hooks.onEvent?.({ type: "sessionDiscovered", info, runtime });
      runtime.setHydrating(true);
      this.hydratingSessionIds.add(info.id);
      void this.hydrateSession(info.id, session, runtime, cols, rows);
      debug(`reconnected to server session: ${info.id}`, "server-client");
    }
  }

  registerSession(id: string, command: string, cols: number, rows: number, promptPatterns?: RegExp[]): ServerSession {
    if (!this.client) {
      throw new Error("Server client is not connected");
    }
    const session = this.client.registerSession(id, command, cols, rows, promptPatterns);
    this.serverSessionIds.add(id);
    return session;
  }

  spawnSession(request: ServerSpawnRequest): ServerSession {
    const session = this.registerSession(
      request.id,
      request.command,
      request.cols,
      request.rows,
      request.promptPatterns,
    );
    if (request.backendSessionId) {
      session.backendSessionId = request.backendSessionId;
      this.backendSessionIds.add(request.backendSessionId);
    }
    this.send({
      type: "spawn",
      id: request.id,
      command: request.command,
      args: request.args,
      toolConfigKey: request.toolConfigKey,
      backendSessionId: request.backendSessionId,
      worktreePath: request.worktreePath,
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
    });
    return session;
  }

  async renameSession(sessionId: string, label?: string): Promise<boolean> {
    if (!this.canControlSession(sessionId)) return false;
    return (await this.client?.renameSession(sessionId, label)) ?? false;
  }

  canControlSession(sessionId: string): boolean {
    return this.connected && this.serverSessionIds.has(sessionId);
  }

  send(msg: any): void {
    this.client?.send(msg);
  }

  disconnect(): void {
    this.client?.disconnect();
    this.client = null;
    this.serverSessionIds.clear();
    this.backendSessionIds.clear();
    this.hydratingSessionIds.clear();
    this.runtimes.clear();
  }

  private async hydrateSession(
    sessionId: string,
    session: {
      id: string;
      resize: (cols: number, rows: number) => void;
      _hydrateSnapshot?: (snapshot: any) => Promise<void> | void;
    },
    runtime: SessionRuntime,
    cols: number,
    rows: number,
  ): Promise<void> {
    if (!this.client) {
      runtime.setHydrating(false);
      this.hydratingSessionIds.delete(sessionId);
      return;
    }

    try {
      let snapshot = await this.client.requestScreen(sessionId);
      if (snapshot.lines.length === 0 && this.client) {
        debug(`hydrate retry resize ${sessionId}: empty snapshot, nudging ${cols}x${rows}`, "reconnect");
        session.resize(cols, rows);
        await new Promise((resolve) => setTimeout(resolve, 150));
        snapshot = await this.client.requestScreen(sessionId);
      }
      debug(
        `hydrate start ${sessionId}: viewport=${snapshot.viewportY} base=${snapshot.baseY} start=${snapshot.startLine} ` +
          `cursor=${snapshot.cursor.row},${snapshot.cursor.col} lines=${snapshot.lines.length}`,
        "reconnect",
      );
      if (typeof session._hydrateSnapshot === "function") {
        await session._hydrateSnapshot(snapshot);
      }
    } catch {
      // Best-effort hydrate only.
    }

    runtime.setHydrating(false);
    this.hydratingSessionIds.delete(sessionId);
    this.hooks.onEvent?.({ type: "sessionHydrated", runtime });
  }
}
