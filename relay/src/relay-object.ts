import { DurableObject } from "cloudflare:workers";
import type { Env, RelayMessage } from "./types.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export class RelayObject extends DurableObject<Env> {
  private daemonWs: WebSocket | null = null;
  private clientSockets = new Set<WebSocket>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const role = url.pathname === "/daemon/connect" ? "daemon" : "client";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [role]);

    if (role === "daemon") {
      if (this.daemonWs) {
        try {
          this.send(this.daemonWs, { type: "error", message: "Replaced by new daemon connection" });
          this.daemonWs.close(1000, "Replaced");
        } catch {}
      }
      this.daemonWs = server;
      this.send(server, { type: "connected", role: "daemon" });
      this.broadcastToClients({ type: "daemon_status", online: true });
    } else {
      this.clientSockets.add(server);
      this.send(server, { type: "connected", role: "client" });
      this.send(server, { type: "daemon_status", online: this.daemonWs !== null });
    }

    this.ensureHeartbeat();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let parsed: RelayMessage;
    try {
      parsed = JSON.parse(message) as RelayMessage;
    } catch {
      this.send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (parsed.type === "pong") return;

    if (parsed.type === "ping") {
      this.send(ws, { type: "pong" });
      return;
    }

    const tags = this.ctx.getTags(ws);
    const isDaemon = tags.includes("daemon");

    if (isDaemon && parsed.type === "response") {
      this.broadcastToClients(parsed);
    } else if (!isDaemon && parsed.type === "request") {
      if (this.daemonWs) {
        try {
          this.daemonWs.send(message);
        } catch {
          this.send(ws, {
            id: parsed.id,
            type: "response",
            status: 502,
            body: { ok: false, error: "Daemon connection lost" },
          });
        }
      } else {
        this.send(ws, {
          id: parsed.id,
          type: "response",
          status: 503,
          body: { ok: false, error: "Daemon not connected" },
        });
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.removeSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.removeSocket(ws);
  }

  async alarm(): Promise<void> {
    const allSockets = this.ctx.getWebSockets();
    for (const ws of allSockets) {
      try {
        this.send(ws, { type: "ping" });
      } catch {
        this.removeSocket(ws);
      }
    }
    if (allSockets.length > 0) {
      this.ensureHeartbeat();
    }
  }

  private removeSocket(ws: WebSocket): void {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("daemon") && this.daemonWs === ws) {
      this.daemonWs = null;
      this.broadcastToClients({ type: "daemon_status", online: false });
    } else {
      this.clientSockets.delete(ws);
    }
    try {
      ws.close(1000, "Closed");
    } catch {}
  }

  private broadcastToClients(msg: RelayMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.clientSockets) {
      try {
        client.send(data);
      } catch {
        this.clientSockets.delete(client);
      }
    }
  }

  private send(ws: WebSocket, msg: RelayMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private ensureHeartbeat(): void {
    this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }
}
