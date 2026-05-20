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

export class RelayClient {
  private ws: WebSocket | null = null;
  private retryMs = INITIAL_RETRY_MS;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly relayUrl: string,
    private readonly token: string,
    private readonly daemon: AimuxDaemon,
  ) {}

  connect(): void {
    if (this.stopped) return;
    const url = `${this.relayUrl}/daemon/connect?token=${encodeURIComponent(this.token)}`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.retryMs = INITIAL_RETRY_MS;
      console.log("[relay] Connected to relay server");
    });

    this.ws.addEventListener("message", (event) => {
      void this.handleMessage(String(event.data));
    });

    this.ws.addEventListener("close", () => {
      this.ws = null;
      if (!this.stopped) {
        console.log(`[relay] Disconnected, retrying in ${this.retryMs}ms`);
        this.scheduleRetry();
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
