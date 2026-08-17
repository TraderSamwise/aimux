import { getClientDeviceInfo, type ClientDeviceInfo } from "@/lib/client-device";
import {
  encodeDevicePublicKey,
  getClientDeviceProof,
  type ClientDeviceProof,
} from "@/lib/client-device-proof";
import type { SecurityEventRecord } from "@/stores/security";

type PendingRequest = {
  resolve: (value: { status: number; body: unknown }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ProjectEventSubscription = {
  path: string;
  headers?: Record<string, string>;
  onEvent: (event: string, data: unknown) => void;
  onError: (error: Error) => void;
};

interface RelayResponse {
  id: string;
  type: "response";
  status: number;
  body?: unknown;
}

interface RelayProjectEventsSubscribed {
  id: string;
  type: "project_events_subscribed";
}

interface RelayProjectEvent {
  id: string;
  type: "project_event";
  event: string;
  data: unknown;
}

interface RelayProjectEventsError {
  id: string;
  type: "project_events_error";
  status?: number;
  message: string;
  deviceId?: string;
  approvalCode?: string;
}

interface RelayControl {
  type: "ping" | "pong" | "connected" | "error" | "daemon_status" | "security_event";
  online?: boolean;
  message?: string;
  event?: SecurityEventRecord;
}

type RelayMessage =
  | RelayResponse
  | RelayProjectEventsSubscribed
  | RelayProjectEvent
  | RelayProjectEventsError
  | RelayControl;

const REQUEST_TIMEOUT_MS = 30_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const HANDSHAKE_FAILURE_AUTH_THRESHOLD = 3;
const TOKEN_PROTOCOL_PREFIX = "aimux-token.";

let idCounter = 0;

export type RelayStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "device_pending"
  | "daemon_offline"
  | "relay_unavailable"
  | "auth_failed";

export type RelayStatusListener = (status: RelayStatus) => void;
export type RelayPendingApprovalListener = (
  approval: { deviceId?: string; approvalCode?: string } | null,
) => void;
export type RelaySecurityEventListener = (event: SecurityEventRecord) => void;

export interface RelayTransportOptions {
  ownerUserId?: string;
  shareId?: string;
  getDeviceProof?: (device: ClientDeviceInfo) => Promise<ClientDeviceProof>;
}

export class RelayTransport {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private retryMs = INITIAL_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private daemonOnline = false;
  private deviceId: string | null = null;
  private consecutiveHandshakeFailures = 0;
  private _status: RelayStatus = "disconnected";
  private pendingApproval: { deviceId?: string; approvalCode?: string } | null = null;
  private listeners = new Set<RelayStatusListener>();
  private pendingApprovalListeners = new Set<RelayPendingApprovalListener>();
  private securityEventListeners = new Set<RelaySecurityEventListener>();
  private projectEventSubscriptions = new Map<string, ProjectEventSubscription>();

  private readonly relayUrl: string;

  constructor(
    relayUrl: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly getDeviceInfo: () => Promise<ClientDeviceInfo> = getClientDeviceInfo,
    private readonly options: RelayTransportOptions = {},
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

  onPendingApprovalChange(listener: RelayPendingApprovalListener): () => void {
    this.pendingApprovalListeners.add(listener);
    return () => this.pendingApprovalListeners.delete(listener);
  }

  onSecurityEvent(listener: RelaySecurityEventListener): () => void {
    this.securityEventListeners.add(listener);
    return () => this.securityEventListeners.delete(listener);
  }

  private setStatus(status: RelayStatus): void {
    if (this._status === status) return;
    this._status = status;
    if (status !== "device_pending") this.setPendingApproval(null);
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  private setPendingApproval(approval: { deviceId?: string; approvalCode?: string } | null): void {
    if (
      this.pendingApproval?.deviceId === approval?.deviceId &&
      this.pendingApproval?.approvalCode === approval?.approvalCode
    ) {
      return;
    }
    this.pendingApproval = approval;
    for (const listener of this.pendingApprovalListeners) {
      listener(approval);
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

    try {
      const deviceInfo = await this.getDeviceInfo();
      this.deviceId = deviceInfo.deviceId;
      const deviceProof = await (this.options.getDeviceProof ?? getClientDeviceProof)(deviceInfo);
      const url = this.clientConnectUrl(deviceInfo, deviceProof);
      this.ws = new WebSocket(url, ["aimux", `${TOKEN_PROTOCOL_PREFIX}${token}`]);
    } catch {
      this.setStatus("disconnected");
      this.scheduleRetry();
      return;
    }

    let opened = false;

    this.ws.onopen = () => {
      opened = true;
      this.consecutiveHandshakeFailures = 0;
      this.retryMs = INITIAL_RETRY_MS;
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(String(event.data));
    };

    this.ws.onclose = (event) => {
      this.ws = null;
      this.rejectAllPending("Connection lost");
      this.rejectAllProjectEventSubscriptions("Connection lost");
      const code = (event as CloseEvent).code;
      if (code === 1008 || code === 4001 || code === 4003) {
        this.stopped = true;
        this.setStatus("auth_failed");
        return;
      }
      if (!opened) {
        this.consecutiveHandshakeFailures += 1;
        if (this.consecutiveHandshakeFailures >= HANDSHAKE_FAILURE_AUTH_THRESHOLD) {
          this.setStatus("relay_unavailable");
          this.scheduleRetry();
          return;
        }
      }
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
    this.rejectAllProjectEventSubscriptions("Disconnected");
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

  get wsConnected(): boolean {
    return this._status === "connected" || this._status === "daemon_offline";
  }

  subscribeProjectEvents(
    path: string,
    headers: Record<string, string> | undefined,
    onEvent: (event: string, data: unknown) => void,
    onError: (error: Error) => void,
  ): { stop: () => void } {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay not connected");
    }
    if (!this.daemonOnline) {
      throw new Error("Daemon not connected to relay");
    }

    const id = `e${++idCounter}`;
    this.projectEventSubscriptions.set(id, { path, headers, onEvent, onError });
    try {
      this.ws.send(JSON.stringify({ id, type: "project_events_subscribe", path, headers }));
    } catch (err) {
      this.projectEventSubscriptions.delete(id);
      throw err instanceof Error ? err : new Error("Relay send failed");
    }

    return {
      stop: () => {
        const entry = this.projectEventSubscriptions.get(id);
        if (!entry) return;
        this.projectEventSubscriptions.delete(id);
        try {
          this.ws?.send(JSON.stringify({ id, type: "project_events_unsubscribe" }));
        } catch {}
      },
    };
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
      if (this._status === "device_pending") return;
      this.setStatus(this.daemonOnline ? "connected" : "daemon_offline");
      return;
    }

    if (msg.type === "error") {
      return;
    }

    if (msg.type === "security_event") {
      if (isSecurityEventRecord(msg.event)) {
        if (msg.event.deviceId && msg.event.deviceId === this.deviceId) {
          if (msg.event.kind === "device_approved") {
            this.setStatus(this.daemonOnline ? "connected" : "daemon_offline");
          } else if (msg.event.kind === "device_blocked") {
            this.setStatus("auth_failed");
          } else if (msg.event.kind === "new_client_detected") {
            this.setPendingApproval({
              deviceId: msg.event.deviceId,
              approvalCode: msg.event.approvalCode,
            });
            this.setStatus("device_pending");
          }
        }
        for (const listener of this.securityEventListeners) {
          listener(msg.event);
        }
      }
      return;
    }

    if (msg.type === "response") {
      const entry = this.pending.get(msg.id);
      if (entry) {
        const pendingApproval = pendingSecurityApprovalFromResponse(msg.status, msg.body);
        if (pendingApproval) {
          this.setPendingApproval(pendingApproval);
          this.setStatus("device_pending");
        }
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        entry.resolve({ status: msg.status, body: msg.body });
      }
      return;
    }

    if (msg.type === "project_events_subscribed") {
      return;
    }

    if (msg.type === "project_event") {
      const entry = this.projectEventSubscriptions.get(msg.id);
      if (entry) entry.onEvent(msg.event, msg.data);
      return;
    }

    if (msg.type === "project_events_error") {
      const entry = this.projectEventSubscriptions.get(msg.id);
      if (entry) {
        const pendingApproval = pendingSecurityApprovalFromResponse(msg.status, {
          error: msg.message,
          deviceId: msg.deviceId,
          approvalCode: msg.approvalCode,
        });
        if (pendingApproval) {
          this.setPendingApproval(pendingApproval);
          this.setStatus("device_pending");
        }
        this.projectEventSubscriptions.delete(msg.id);
        entry.onError(new Error(msg.message || `project event stream failed (${msg.status ?? 0})`));
      }
    }
  }

  private clientConnectUrl(device: ClientDeviceInfo, proof: ClientDeviceProof): string {
    const url = new URL(`${this.relayUrl}/client/connect`);
    url.searchParams.set("deviceId", device.deviceId);
    url.searchParams.set("deviceKind", device.kind);
    url.searchParams.set("deviceName", device.name);
    url.searchParams.set("devicePlatform", device.platform);
    if (device.appVersion) url.searchParams.set("appVersion", device.appVersion);
    if (device.approvalCode) url.searchParams.set("approvalCode", device.approvalCode);
    url.searchParams.set("deviceKeyAlg", proof.alg);
    url.searchParams.set("devicePublicKey", encodeDevicePublicKey(proof.publicKeyJwk));
    url.searchParams.set("deviceProofTs", proof.timestamp);
    url.searchParams.set("deviceProofNonce", proof.nonce);
    url.searchParams.set("deviceProof", proof.signature);
    if (this.options.ownerUserId) url.searchParams.set("ownerUserId", this.options.ownerUserId);
    if (this.options.shareId) url.searchParams.set("shareId", this.options.shareId);
    return url.toString();
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private rejectAllProjectEventSubscriptions(reason: string): void {
    for (const [id, entry] of this.projectEventSubscriptions) {
      entry.onError(new Error(reason));
      this.projectEventSubscriptions.delete(id);
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

function pendingSecurityApprovalFromResponse(
  status: number | undefined,
  body: unknown,
): { deviceId?: string; approvalCode?: string } | null {
  if (status !== 403) return null;
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const payload = body as { error?: unknown; deviceId?: unknown; approvalCode?: unknown };
  if (!/pending security approval/i.test(String(payload.error))) return null;
  const approvalCode =
    typeof payload.approvalCode === "string"
      ? payload.approvalCode
      : String(payload.error)
          .match(/\bCode\s+([2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3})\b/i)?.[1]
          ?.toUpperCase();
  return {
    deviceId: typeof payload.deviceId === "string" ? payload.deviceId : undefined,
    approvalCode,
  };
}

function isSecurityEventRecord(value: unknown): value is SecurityEventRecord {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<Record<keyof SecurityEventRecord, unknown>>;
  return (
    typeof event.id === "string" &&
    typeof event.kind === "string" &&
    typeof event.title === "string" &&
    typeof event.body === "string" &&
    typeof event.createdAt === "string"
  );
}
