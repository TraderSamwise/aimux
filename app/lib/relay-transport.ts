type PendingRequest = {
  resolve: (value: { status: number; body: unknown }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

interface RelayResponse {
  id: string;
  type: "response";
  status: number;
  body: unknown;
}

interface RelayControl {
  type: "ping" | "pong" | "connected" | "error" | "daemon_status";
  online?: boolean;
  message?: string;
}

type RelayMessage = RelayResponse | RelayControl;

const REQUEST_TIMEOUT_MS = 30_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

let idCounter = 0;

export type RelayStatus = "disconnected" | "connecting" | "connected" | "daemon_offline";

export type RelayStatusListener = (status: RelayStatus) => void;

export class RelayTransport {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private retryMs = INITIAL_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private daemonOnline = false;
  private _status: RelayStatus = "disconnected";
  private listeners = new Set<RelayStatusListener>();

  private readonly relayUrl: string;

  constructor(
    relayUrl: string,
    private readonly getToken: () => Promise<string | null>,
  ) {
    this.relayUrl = relayUrl.replace(/\/+$/, "");
  }

  get status(): RelayStatus {
    return this._status;
  }

  onStatusChange(listener: RelayStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: RelayStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");

    const token = await this.getToken();
    if (!token) {
      this.setStatus("disconnected");
      this.scheduleRetry();
      return;
    }

    const url = `${this.relayUrl}/client/connect?token=${encodeURIComponent(token)}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.setStatus("disconnected");
      this.scheduleRetry();
      return;
    }

    this.ws.onopen = () => {
      this.retryMs = INITIAL_RETRY_MS;
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(String(event.data));
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.rejectAllPending("Connection lost");
      if (!this.stopped) {
        this.setStatus("disconnected");
        this.scheduleRetry();
      }
    };

    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {}
    };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.rejectAllPending("Disconnected");
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {}
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay not connected");
    }
    if (!this.daemonOnline) {
      throw new Error("Daemon not connected to relay");
    }

    const id = `r${++idCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Relay request timed out"));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ id, type: "request", method, path, body }));
      } catch (err) {
        // The socket can close between the readyState check above and the
        // send call (race with onclose / network drop). Clean up the entry
        // so it doesn't sit there until the request timer fires.
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error("Relay send failed"));
      }
    });
  }

  get isConnected(): boolean {
    return this._status === "connected" && this.daemonOnline;
  }

  private handleMessage(data: string): void {
    let msg: RelayMessage;
    try {
      msg = JSON.parse(data) as RelayMessage;
    } catch {
      return;
    }

    if (msg.type === "ping") {
      this.ws?.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "connected") {
      return;
    }

    if (msg.type === "daemon_status") {
      this.daemonOnline = msg.online ?? false;
      this.setStatus(this.daemonOnline ? "connected" : "daemon_offline");
      return;
    }

    if (msg.type === "error") {
      return;
    }

    if (msg.type === "response") {
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        entry.resolve({ status: msg.status, body: msg.body });
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }
}
