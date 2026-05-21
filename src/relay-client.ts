import type { AimuxDaemon } from "./daemon.js";

interface RelayRequest {
  id: string;
  type: "request";
  method: string;
  path: string;
  body?: unknown;
}

interface RelayControl {
  type: "ping" | "pong" | "connected" | "error" | "daemon_status";
  message?: string;
}

type RelayMessage = RelayRequest | RelayControl;

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

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

  constructor(
    private readonly relayUrl: string,
    private readonly token: string,
    private readonly daemon: AimuxDaemon,
  ) {}

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
      this.status = "auth_failed";
      this.lastError = "Node runtime is missing globalThis.WebSocket — upgrade to Node 22+ to use the aimux relay";
      this.stopped = true;
      return;
    }
    this.status = this.lastConnectedAt ? "reconnecting" : "connecting";
    const url = `${this.relayUrl}/daemon/connect?token=${encodeURIComponent(this.token)}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRetry();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.retryMs = INITIAL_RETRY_MS;
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
      // 1008/4001 = auth rejected by relay; don't hammer with retries.
      const code = (event as unknown as { code?: number }).code;
      if (code === 1008 || code === 4001) {
        this.status = "auth_failed";
        this.lastError = "Relay rejected credentials — run `aimux login` again";
        console.warn(`[relay] Auth failed (code ${code}). Stopping reconnect.`);
        return;
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
