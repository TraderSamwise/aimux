import type { AimuxDaemon } from "./daemon.js";
import { notifyRemoteClientConnected } from "./notify.js";

interface RelayRequest {
  id: string;
  type: "request";
  method: string;
  path: string;
  body?: unknown;
}

interface RelayControl {
  type: "ping" | "pong" | "connected" | "error" | "daemon_status" | "security_event";
  message?: string;
  event?: {
    kind: string;
    title: string;
    body: string;
    deviceId?: string;
    createdAt: string;
  };
}

type RelayMessage = RelayRequest | RelayControl;

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const MAX_HANDSHAKE_FAILURES = 5;
const TOKEN_PROTOCOL_PREFIX = "aimux-token.";

export type RelayConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected" | "auth_failed";

export interface RelayStatusSnapshot {
  status: RelayConnectionStatus;
  relayUrl: string;
  lastConnectedAt: string | null;
  lastError: string | null;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private retryMs = INITIAL_RETRY_MS;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private status: RelayConnectionStatus = "disconnected";
  private lastConnectedAt: string | null = null;
  private lastError: string | null = null;
  private readonly relayUrl: string;
  private handshakeFailures = 0;

  constructor(
    relayUrl: string,
    private readonly token: string,
    private readonly daemon: AimuxDaemon,
  ) {
    this.relayUrl = relayUrl.replace(/\/+$/, "");
  }

  getStatus(): RelayStatusSnapshot {
    return {
      status: this.status,
      relayUrl: this.relayUrl,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
    };
  }

  connect(): void {
    if (this.stopped) return;
    // Node 22+ ships WebSocket on globalThis; 18/20 don't. Fail fast with a
    // clear error so the user doesn't see an endless reconnect loop full of
    // ReferenceErrors when running on an older runtime.
    if (typeof globalThis.WebSocket !== "function") {
      this.status = "disconnected";
      this.lastError = "Node runtime is missing globalThis.WebSocket — upgrade to Node 22+ to use the aimux relay";
      this.stopped = true;
      return;
    }
    this.status = this.lastConnectedAt ? "reconnecting" : "connecting";
    const url = `${this.relayUrl}/daemon/connect`;

    try {
      this.ws = new WebSocket(url, ["aimux", `${TOKEN_PROTOCOL_PREFIX}${this.token}`]);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRetry();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.retryMs = INITIAL_RETRY_MS;
      this.handshakeFailures = 0;
      this.status = "connected";
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = null;
      console.log("[relay] Connected to relay server");
    });

    this.ws.addEventListener("message", (event) => {
      void this.handleMessage(String(event.data));
    });

    this.ws.addEventListener("close", (event) => {
      this.ws = null;
      const code = (event as unknown as { code?: number }).code;
      // 1008/4001 = auth rejected by relay; don't hammer with retries.
      if (code === 1008 || code === 4001) {
        this.status = "auth_failed";
        this.lastError = "Relay rejected credentials — run `aimux login` again";
        console.warn(`[relay] Auth failed (code ${code}). Stopping reconnect.`);
        return;
      }
      // 1006 = abnormal close, often a failed HTTP upgrade (e.g. 401).
      // Stop after repeated handshake failures to avoid infinite retry spam.
      if (code === 1006) {
        this.handshakeFailures++;
        if (this.handshakeFailures >= MAX_HANDSHAKE_FAILURES) {
          this.status = "auth_failed";
          this.lastError = "Too many handshake failures — token may be expired, run `aimux login` again";
          console.warn(`[relay] ${MAX_HANDSHAKE_FAILURES} consecutive handshake failures. Stopping reconnect.`);
          return;
        }
      }
      if (!this.stopped) {
        this.status = "reconnecting";
        console.log(`[relay] Disconnected, retrying in ${this.retryMs}ms`);
        this.scheduleRetry();
      } else {
        this.status = "disconnected";
      }
    });

    this.ws.addEventListener("error", () => {
      try {
        this.ws?.close();
      } catch {}
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.status = "disconnected";
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.ws) {
      try {
        this.ws.close(1000, "Daemon shutting down");
      } catch {}
      this.ws = null;
    }
  }

  private async handleMessage(data: string): Promise<void> {
    let msg: RelayMessage;
    try {
      msg = JSON.parse(data) as RelayMessage;
    } catch {
      return;
    }

    if (msg.type === "ping") {
      this.sendRaw(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "connected") {
      console.log("[relay] Registered as daemon");
      return;
    }

    if (msg.type === "error") {
      console.warn("[relay] Server error:", msg.message);
      return;
    }

    if (msg.type === "security_event") {
      if (msg.event?.kind === "client_connected") {
        notifyRemoteClientConnected({
          title: msg.event.title,
          body: msg.event.body,
        });
      }
      return;
    }

    if (msg.type === "request") {
      try {
        const result = await this.daemon.routeRequest(msg.method, msg.path, msg.body);
        this.sendRaw(JSON.stringify({ id: msg.id, type: "response", status: result.status, body: result.body }));
      } catch (err) {
        this.sendRaw(
          JSON.stringify({
            id: msg.id,
            type: "response",
            status: 500,
            body: { ok: false, error: err instanceof Error ? err.message : "Internal error" },
          }),
        );
      }
    }
  }

  private sendRaw(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }
}
