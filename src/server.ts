import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Multiplexer } from "./multiplexer.js";
import { RemoteTerminalIO } from "./terminal-io.js";

const AIMUX_DIR = join(homedir(), ".aimux");
const SOCKET_PATH = join(AIMUX_DIR, "aimux.sock");
const API_SOCKET_PATH = join(AIMUX_DIR, "aimux-api.sock");
const PID_PATH = join(AIMUX_DIR, "aimux.pid");

export function getSocketPath(): string {
  return SOCKET_PATH;
}

export function getApiSocketPath(): string {
  return API_SOCKET_PATH;
}

export function getPidPath(): string {
  return PID_PATH;
}

/** Check if a server is already running */
export function isServerRunning(): boolean {
  if (!existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    // Check if process is alive (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return true;
  } catch {
    // Process not running — clean up stale files
    try {
      unlinkSync(PID_PATH);
    } catch {}
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
    return false;
  }
}

export class AimuxServer {
  private server: Server;
  private apiServer: HttpServer;
  private io: RemoteTerminalIO;
  private mux: Multiplexer;
  private currentClient: Socket | null = null;
  private startedAt = Date.now();

  constructor() {
    this.io = new RemoteTerminalIO();
    this.mux = new Multiplexer(this.io);
    this.server = createServer((socket) => this.handleConnection(socket));
    this.apiServer = createHttpServer((req, res) => this.handleApiRequest(req, res));
  }

  async start(): Promise<void> {
    mkdirSync(AIMUX_DIR, { recursive: true });

    // Check for stale sockets
    if (existsSync(SOCKET_PATH)) {
      if (isServerRunning()) {
        throw new Error("Server is already running");
      }
      unlinkSync(SOCKET_PATH);
    }
    if (existsSync(API_SOCKET_PATH)) {
      try {
        unlinkSync(API_SOCKET_PATH);
      } catch {}
    }

    // Write PID file
    writeFileSync(PID_PATH, String(process.pid));

    // Start PTY client socket
    await new Promise<void>((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(SOCKET_PATH, () => resolve());
    });

    // Start API socket
    await new Promise<void>((resolve, reject) => {
      this.apiServer.on("error", reject);
      this.apiServer.listen(API_SOCKET_PATH, () => resolve());
    });

    // Set up signal handlers
    const cleanup = () => {
      this.shutdown();
      process.exit(0);
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    // Start the multiplexer in dashboard mode
    try {
      await this.mux.runDashboard();
    } finally {
      this.shutdown();
    }
  }

  private handleConnection(socket: Socket): void {
    if (this.currentClient && !this.currentClient.destroyed) {
      // Reject additional clients — only one at a time
      socket.end("Another client is already connected.\n");
      return;
    }

    this.currentClient = socket;
    this.io.bindSocket(socket);

    socket.on("close", () => {
      if (this.currentClient === socket) {
        this.currentClient = null;
      }
    });

    socket.on("error", () => {
      if (this.currentClient === socket) {
        this.currentClient = null;
      }
    });
  }

  private handleApiRequest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    if (req.url === "/status" && req.method === "GET") {
      const status = this.mux.getStatusInfo();
      const body = JSON.stringify({
        server: {
          pid: process.pid,
          uptime: Math.round((Date.now() - this.startedAt) / 1000),
          clientConnected: this.currentClient !== null && !this.currentClient.destroyed,
        },
        ...status,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  private shutdown(): void {
    this.mux.cleanup();
    this.server.close();
    this.apiServer.close();
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
    try {
      unlinkSync(API_SOCKET_PATH);
    } catch {}
    try {
      unlinkSync(PID_PATH);
    } catch {}
  }
}

/** Start the server in foreground mode (called by the spawned child process) */
export async function startServerForeground(): Promise<void> {
  const server = new AimuxServer();
  await server.start();
}

/** Stop a running server by sending SIGTERM */
export function stopServer(): boolean {
  if (!existsSync(PID_PATH)) {
    return false;
  }
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
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
