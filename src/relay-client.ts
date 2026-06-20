import type { AimuxDaemon } from "./daemon.js";
import { notifyRemoteClientConnected } from "./notify.js";
import { PROJECT_API_ROUTES } from "./project-api-contract.js";
import { assertRemoteAccessAllowed, parseRemoteActor } from "./remote-access.js";

interface RelayRequest {
  id: string;
  type: "request";
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface RelayProjectEventsSubscribe {
  id: string;
  type: "project_events_subscribe";
  path: string;
  headers?: Record<string, string>;
}

interface RelayProjectEventsUnsubscribe {
  id: string;
  type: "project_events_unsubscribe";
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

export interface RelayNotificationPush {
  title: string;
  body: string;
  kind?: string;
  sessionId?: string;
  projectId?: string;
  notificationId?: string;
  projectName?: string;
  projectRoot?: string;
  worktreePath?: string;
  worktreeName?: string;
  branch?: string;
  categoryLabel?: string;
  reasonLabel?: string;
  dedupeKey?: string;
}

type RelayMessage = RelayRequest | RelayProjectEventsSubscribe | RelayProjectEventsUnsubscribe | RelayControl;

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const MAX_HANDSHAKE_FAILURES = 5;
const REMOTE_CLIENT_NOTIFICATION_DEDUPE_MS = 5 * 60 * 1000;
const TOKEN_PROTOCOL_PREFIX = "aimux-token.";
const PROXY_ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const DAEMON_ROUTE_BASE_URL = "http://127.0.0.1";

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
  private readonly recentRemoteClientNotifications = new Map<string, number>();
  private readonly projectEventSubscriptions = new Map<string, AbortController>();

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
    // Aimux targets Node 24+; fail fast when an older runtime lacks WebSocket.
    // clear error so the user doesn't see an endless reconnect loop full of
    // ReferenceErrors when running on an older runtime.
    if (typeof globalThis.WebSocket !== "function") {
      this.status = "disconnected";
      this.lastError = "Node runtime is missing globalThis.WebSocket — upgrade to Node 24+ to use the aimux relay";
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

  pushNotification(notification: RelayNotificationPush): void {
    if (!notification.title) return;
    this.sendRaw(JSON.stringify({ type: "notification_push", notification }));
  }

  disconnect(): void {
    this.stopped = true;
    this.status = "disconnected";
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.abortProjectEventSubscriptions();
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
        const dedupeKey = msg.event.deviceId ?? `${msg.event.title}:${msg.event.body}`;
        if (this.shouldNotifyRemoteClientConnected(dedupeKey)) {
          notifyRemoteClientConnected({
            title: msg.event.title,
            body: msg.event.body,
          });
        }
      }
      return;
    }

    if (msg.type === "project_events_subscribe") {
      this.startProjectEventSubscription(msg);
      return;
    }

    if (msg.type === "project_events_unsubscribe") {
      this.stopProjectEventSubscription(msg.id);
      return;
    }

    if (msg.type === "request") {
      try {
        const result = await this.daemon.routeRequest(msg.method, msg.path, msg.body, msg.headers);
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

  private startProjectEventSubscription(message: RelayProjectEventsSubscribe): void {
    this.stopProjectEventSubscription(message.id);
    const controller = new AbortController();
    this.projectEventSubscriptions.set(message.id, controller);
    void this.runProjectEventSubscription(message, controller).finally(() => {
      if (this.projectEventSubscriptions.get(message.id) === controller) {
        this.projectEventSubscriptions.delete(message.id);
      }
    });
  }

  private async runProjectEventSubscription(
    message: RelayProjectEventsSubscribe,
    controller: AbortController,
  ): Promise<void> {
    const routed = this.resolveProjectEventsRoute(message.path, message.headers);
    if (!routed.ok) {
      this.sendRaw(
        JSON.stringify({
          id: message.id,
          type: "project_events_error",
          status: routed.status,
          message: routed.error,
        }),
      );
      return;
    }

    try {
      const response = await fetch(routed.url, { method: "GET", signal: controller.signal });
      if (!response.ok || !response.body) {
        this.sendRaw(
          JSON.stringify({
            id: message.id,
            type: "project_events_error",
            status: response.status,
            message: response.statusText || `HTTP ${response.status}`,
          }),
        );
        return;
      }
      this.sendRaw(JSON.stringify({ id: message.id, type: "project_events_subscribed" }));
      await this.readProjectEventStream(message.id, response.body, controller.signal);
      if (!controller.signal.aborted) {
        this.sendRaw(
          JSON.stringify({
            id: message.id,
            type: "project_events_error",
            status: 502,
            message: "Project event stream closed",
          }),
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      this.sendRaw(
        JSON.stringify({
          id: message.id,
          type: "project_events_error",
          status: 502,
          message: err instanceof Error ? err.message : "Project event stream failed",
        }),
      );
    }
  }

  private resolveProjectEventsRoute(
    path: string,
    headers?: Record<string, string>,
  ): { ok: true; url: string } | { ok: false; status: number; error: string } {
    const routeUrl = new URL(path, DAEMON_ROUTE_BASE_URL);
    const pathname = routeUrl.pathname;
    const actor = parseRemoteActor(headers);
    const access = assertRemoteAccessAllowed(actor, "GET", pathname, routeUrl.searchParams);
    if (!access.ok) {
      return { ok: false, status: access.status ?? 403, error: access.error ?? "remote access denied" };
    }
    const proxyMatch = pathname.match(/^\/proxy\/([^/]+)\/(\d+)(\/.*)/);
    if (!proxyMatch) return { ok: false, status: 400, error: "project event stream must use a project proxy path" };
    const [, host, portStr, subPath] = proxyMatch;
    if (!PROXY_ALLOWED_HOSTS.has(host)) return { ok: false, status: 403, error: "proxy host not allowed" };
    if (subPath !== PROJECT_API_ROUTES.events) {
      return { ok: false, status: 400, error: "project event stream path must be /events" };
    }
    return { ok: true, url: `http://${host}:${portStr}${subPath}${routeUrl.search}` };
  }

  private async readProjectEventStream(
    subscriptionId: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.flushProjectEventFrames(subscriptionId, buffer);
      }
      buffer += decoder.decode();
      this.flushProjectEventFrames(subscriptionId, `${buffer}\n\n`);
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  private flushProjectEventFrames(subscriptionId: string, buffer: string): string {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const frames = normalized.split("\n\n");
    const remainder = frames.pop() ?? "";
    for (const frame of frames) {
      this.forwardProjectEventFrame(subscriptionId, frame);
    }
    return remainder;
  }

  private forwardProjectEventFrame(subscriptionId: string, frame: string): void {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    try {
      this.sendRaw(
        JSON.stringify({
          id: subscriptionId,
          type: "project_event",
          event,
          data: JSON.parse(dataLines.join("\n")),
        }),
      );
    } catch (err) {
      this.sendRaw(
        JSON.stringify({
          id: subscriptionId,
          type: "project_events_error",
          status: 502,
          message: err instanceof Error ? err.message : "Invalid project event payload",
        }),
      );
    }
  }

  private stopProjectEventSubscription(id: string): void {
    const controller = this.projectEventSubscriptions.get(id);
    if (!controller) return;
    controller.abort();
    this.projectEventSubscriptions.delete(id);
  }

  private abortProjectEventSubscriptions(): void {
    for (const controller of this.projectEventSubscriptions.values()) {
      controller.abort();
    }
    this.projectEventSubscriptions.clear();
  }

  private sendRaw(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private shouldNotifyRemoteClientConnected(key: string): boolean {
    const now = Date.now();
    for (const [existingKey, lastNotifiedAt] of this.recentRemoteClientNotifications) {
      if (now - lastNotifiedAt > REMOTE_CLIENT_NOTIFICATION_DEDUPE_MS) {
        this.recentRemoteClientNotifications.delete(existingKey);
      }
    }
    const previous = this.recentRemoteClientNotifications.get(key);
    if (previous && now - previous <= REMOTE_CLIENT_NOTIFICATION_DEDUPE_MS) return false;
    this.recentRemoteClientNotifications.set(key, now);
    return true;
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
