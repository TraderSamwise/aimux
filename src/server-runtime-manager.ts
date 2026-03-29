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
  onHydrated: (runtime: SessionRuntime) => void;
}

export class ServerRuntimeManager {
  private client: ServerClient | null = null;
  private readonly serverSessionIds = new Set<string>();
  private readonly hydratingSessionIds = new Set<string>();

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  isServerSession(sessionId: string): boolean {
    return this.serverSessionIds.has(sessionId);
  }

  isHydrating(sessionId: string): boolean {
    return this.hydratingSessionIds.has(sessionId);
  }

  async connect(onSessionUpdated: (update: { id: string; label?: string }) => void): Promise<void> {
    if (!ServerClient.isAvailable()) return;
    const client = new ServerClient();
    await client.connect();
    client.onSessionUpdated(onSessionUpdated);
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
      const runtime = hooks.onDiscovered(info, session);
      runtime.setHydrating(true);
      this.hydratingSessionIds.add(info.id);
      void this.hydrateSession(info.id, session, runtime, cols, rows, hooks.onHydrated);
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

  async renameSession(sessionId: string, label?: string): Promise<boolean> {
    return (await this.client?.renameSession(sessionId, label)) ?? false;
  }

  send(msg: any): void {
    this.client?.send(msg);
  }

  disconnect(): void {
    this.client?.disconnect();
    this.client = null;
    this.serverSessionIds.clear();
    this.hydratingSessionIds.clear();
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
    onHydrated: (runtime: SessionRuntime) => void,
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
    onHydrated(runtime);
  }
}
