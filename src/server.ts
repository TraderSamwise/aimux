import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PtySession, type PtySessionOptions } from "./pty-session.js";
import { registerInstance, unregisterInstance, updateHeartbeat, type InstanceSessionRef } from "./instance-registry.js";
import { initProject, loadConfig } from "./config.js";
import { getLocalAimuxDir } from "./paths.js";
import { debug } from "./debug.js";

const AIMUX_DIR = join(homedir(), ".aimux");
const PID_PATH = join(AIMUX_DIR, "aimux.pid");

export function getPidPath(): string {
  return PID_PATH;
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

/**
 * Headless aimux server — owns PTY sessions without a terminal.
 * Participates in the same file-based coordination system (instances.json,
 * state.json, sessions.json) as direct-mode aimux.
 *
 * Sessions on the server persist until explicitly killed. Direct-mode
 * aimux sees server sessions as "remote" and can take them over.
 */
export class AimuxServer {
  private sessions: PtySession[] = [];
  private instanceId = `server-${Math.random().toString(36).slice(2, 8)}`;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();

  async start(): Promise<void> {
    mkdirSync(AIMUX_DIR, { recursive: true });

    if (isServerRunning()) {
      throw new Error("Server is already running");
    }

    writeFileSync(PID_PATH, String(process.pid));
    debug(`server started (PID ${process.pid})`, "server");

    // Register in the instance registry (same as direct-mode aimux)
    await registerInstance(this.instanceId, process.cwd());

    // Heartbeat — same 5s interval as direct mode
    this.heartbeatInterval = setInterval(() => {
      const refs = this.getSessionRefs();
      updateHeartbeat(this.instanceId, refs, process.cwd()).catch(() => {});
    }, 5000);

    // Signal handlers
    const cleanup = () => this.shutdown();
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    // Keep the process alive
    await new Promise<void>(() => {
      // Never resolves — server runs until killed
    });
  }

  /** Spawn a new agent session on the server */
  spawnSession(tool: string, args: string[], cwd?: string): PtySession {
    initProject();

    const config = loadConfig();
    const toolEntry = Object.entries(config.tools).find(([, t]) => t.command === tool);
    const toolCfg = toolEntry?.[1];

    const sessionId = `${tool}-${Math.random().toString(36).slice(2, 8)}`;

    // Build prompt patterns from config
    let promptPatterns: RegExp[] | undefined;
    if (toolCfg?.promptPatterns) {
      promptPatterns = toolCfg.promptPatterns.map((p) => new RegExp(p, "m"));
    }

    const session = new PtySession({
      command: tool,
      args,
      cols: 120, // headless — use reasonable defaults
      rows: 40,
      id: sessionId,
      cwd: cwd ?? process.cwd(),
      promptPatterns,
    });

    session.onExit((code) => {
      debug(`server session exited: ${session.id} (code=${code})`, "server");
      const idx = this.sessions.indexOf(session);
      if (idx >= 0) this.sessions.splice(idx, 1);
    });

    this.sessions.push(session);
    debug(`server spawned session: ${session.id} (${tool})`, "server");
    return session;
  }

  private getSessionRefs(): InstanceSessionRef[] {
    return this.sessions.map((s) => ({
      id: s.id,
      tool: s.command,
      backendSessionId: s.backendSessionId,
    }));
  }

  private shutdown(): void {
    debug("server shutting down", "server");

    // Kill all sessions
    for (const session of this.sessions) {
      session.kill();
    }
    this.sessions = [];

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Unregister
    unregisterInstance(this.instanceId, process.cwd()).catch(() => {});

    // Clean up PID file
    try {
      unlinkSync(PID_PATH);
    } catch {}

    process.exit(0);
  }

  /** Get status for external consumers (tray app, CLI) */
  getStatus() {
    return {
      pid: process.pid,
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
      sessions: this.sessions.map((s) => ({
        id: s.id,
        tool: s.command,
        status: s.status,
        backendSessionId: s.backendSessionId,
      })),
    };
  }
}

/** Start the server in foreground mode */
export async function startServerForeground(): Promise<void> {
  const server = new AimuxServer();
  await server.start();
}
