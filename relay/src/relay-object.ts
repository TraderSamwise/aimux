import { DurableObject } from "cloudflare:workers";
import type { Env, RelayMessage } from "./types.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
// In-flight requests: response with this id will be routed back to the
// requesting client only. Entries are cleared on response, client close, or
// after this TTL — bounds memory if a request never completes.
const PENDING_REQUEST_TTL_MS = 60_000;

export class RelayObject extends DurableObject<Env> {
  private daemonWs: WebSocket | null = null;
  private clientSockets = new Set<WebSocket>();
  private pendingRequests = new Map<string, { client: WebSocket; clientRequestId: string; expiresAt: number }>();
  private requestCounter = 0;

  async fetch(request: Request): Promise<Response> {
    this.rehydrateSockets();
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade")?.toLowerCase();
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const role = url.pathname === "/daemon/connect" ? "daemon" : "client";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [role]);

    if (role === "daemon") {
      if (this.daemonWs) {
        this.failPendingRequests("Daemon connection replaced", 502);
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

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "aimux" },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.rehydrateSockets();
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
      this.sweepExpiredPending();
      const pending = this.pendingRequests.get(parsed.id);
      if (pending) {
        this.pendingRequests.delete(parsed.id);
        try {
          pending.client.send(JSON.stringify({ ...parsed, id: pending.clientRequestId }));
        } catch {
          // client has gone away — drop silently
        }
      }
    } else if (!isDaemon && parsed.type === "request") {
      if (this.daemonWs) {
        const relayRequestId = this.nextRelayRequestId();
        this.pendingRequests.set(relayRequestId, {
          client: ws,
          clientRequestId: parsed.id,
          expiresAt: Date.now() + PENDING_REQUEST_TTL_MS,
        });
        const daemonMessage = JSON.stringify({ ...parsed, id: relayRequestId });
        try {
          this.daemonWs.send(daemonMessage);
        } catch {
          this.pendingRequests.delete(relayRequestId);
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

  private sweepExpiredPending(): void {
    const now = Date.now();
    for (const [relayRequestId, entry] of this.pendingRequests) {
      if (entry.expiresAt >= now) continue;
      this.pendingRequests.delete(relayRequestId);
      // Tell the waiting client the request never made it back, so it can
      // fail-fast instead of hanging until its own transport timeout.
      try {
        entry.client.send(
          JSON.stringify({
            id: entry.clientRequestId,
            type: "response",
            status: 504,
            body: { ok: false, error: "Daemon did not respond in time" },
          }),
        );
      } catch {
        // client has gone away — nothing to deliver
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
    this.rehydrateSockets();
    // Reap stale pending-request entries even when the daemon never sent a
    // response — clients waiting on those ids get a 504 back here.
    this.sweepExpiredPending();
    const allSockets = this.ctx.getWebSockets();
    for (const ws of allSockets) {
      try {
        this.send(ws, { type: "ping" });
      } catch {
        this.removeSocket(ws);
      }
    }
    if (allSockets.length > 0 || this.pendingRequests.size > 0) {
      this.ensureHeartbeat();
    }
  }

  private removeSocket(ws: WebSocket): void {
    this.rehydrateSockets(ws);
    const tags = this.ctx.getTags(ws);
    if (tags.includes("daemon") && this.daemonWs === ws) {
      this.daemonWs = null;
      // Fail every in-flight request immediately instead of waiting for
      // the TTL — the daemon that was going to answer just disappeared.
      this.failPendingRequests("Daemon connection lost", 502);
      this.broadcastToClients({ type: "daemon_status", online: false });
    } else {
      this.clientSockets.delete(ws);
      for (const [id, entry] of this.pendingRequests) {
        if (entry.client === ws) this.pendingRequests.delete(id);
      }
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

  private rehydrateSockets(exclude?: WebSocket): void {
    this.daemonWs = null;
    this.clientSockets.clear();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const tags = this.ctx.getTags(ws);
      if (tags.includes("daemon")) {
        if (!this.daemonWs) {
          this.daemonWs = ws;
        } else {
          try {
            ws.close(1000, "Replaced");
          } catch {}
        }
      } else if (tags.includes("client")) {
        this.clientSockets.add(ws);
      }
    }
  }

  private nextRelayRequestId(): string {
    this.requestCounter += 1;
    return `do-${Date.now().toString(36)}-${this.requestCounter}`;
  }

  private failPendingRequests(message: string, status: number): void {
    for (const [, entry] of this.pendingRequests) {
      try {
        entry.client.send(
          JSON.stringify({
            id: entry.clientRequestId,
            type: "response",
            status,
            body: { ok: false, error: message },
          }),
        );
      } catch {
        // client gone too — nothing to deliver
      }
    }
    this.pendingRequests.clear();
  }
}
