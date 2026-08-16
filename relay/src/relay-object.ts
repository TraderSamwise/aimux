import { DurableObject } from "cloudflare:workers";
import type { Env, RelayMessage } from "./types.js";
import { deliverNotificationPush, deliverSecurityAlert } from "./security-delivery.js";
import { deliverShareInvite } from "./sharing-delivery.js";
import {
  activateSecurityLockdown,
  appendSecurityEvent,
  approveSecurityDevice,
  blockSecurityDevice,
  consumeDeviceProofNonce,
  createShareSecurityEvent,
  createSecurityActionToken,
  deactivateSecurityLockdown,
  deviceProofMatchesRecord,
  findSecurityActionByToken,
  hashIpAddress,
  isDaemonTokenRevoked,
  isDeviceApproved,
  isSecurityLockedDown,
  loadSecurityState,
  markSecurityActionUsed,
  notificationPushTokensForDevicePolicy,
  recordClientConnection,
  type DeviceProofInput,
  sanitizeDeviceInfo,
  saveSecurityState,
  securityDeviceApprovalCode,
  shouldEnforceDeviceProof,
  unblockSecurityDevice,
  verifyDeviceProof,
} from "./security.js";
import {
  acceptShareInvite,
  createShareInvite,
  getShareChatMode,
  listAcceptedShares,
  loadSharingState,
  removeAcceptedShare,
  removeShareParticipant,
  revokeShareInvite,
  saveSharingState,
  sharedRelayRequestAccess,
  summarizeShare,
  stripTrustedAimuxHeaders,
  upsertAcceptedShare,
} from "./sharing.js";
import type { ShareParticipantRecord, SharedSessionRecord, SharedSessionSummary } from "./sharing.js";
import type { SecurityDeviceRecord, SecurityEventRecord, VerifiedDeviceProof } from "./security.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
// In-flight requests: response with this id will be routed back to the
// requesting client only. Entries are cleared on response, client close, or
// after this TTL — bounds memory if a request never completes.
const PENDING_REQUEST_TTL_MS = 60_000;

interface ClientSocketAttachment {
  projectEventSubscriptions?: Record<string, string>;
}

interface SharedClientAuth {
  userId: string;
  share: SharedSessionRecord;
  participant: ShareParticipantRecord;
}

export class RelayObject extends DurableObject<Env> {
  private daemonWs: WebSocket | null = null;
  private clientSockets = new Set<WebSocket>();
  private clientDeviceIds = new Map<WebSocket, string>();
  private pendingRequests = new Map<string, { client: WebSocket; clientRequestId: string; expiresAt: number }>();
  private eventSubscriptions = new Map<string, { client: WebSocket; clientSubscriptionId: string }>();
  private requestCounter = 0;

  async fetch(request: Request): Promise<Response> {
    this.rehydrateSockets();
    const url = new URL(request.url);
    if (url.pathname.startsWith("/security/action/")) {
      return this.handleSecurityAction(request, url);
    }
    if (url.pathname === "/security/unlock" && request.method === "POST") {
      return this.unlockSecurity();
    }
    if (url.pathname === "/internal/accepted-shares/upsert" && request.method === "POST") {
      return this.upsertAcceptedShareIndex(request);
    }
    if (url.pathname === "/internal/accepted-shares/remove" && request.method === "POST") {
      return this.removeAcceptedShareIndex(request);
    }
    if (url.pathname === "/security/status" && request.method === "GET") {
      const state = await loadSecurityState(this.ctx.storage);
      return json({ ok: true, locked: isSecurityLockedDown(state), lockdown: state.lockdown }, 200);
    }
    if (url.pathname === "/security/devices" && request.method === "GET") {
      return this.listSecurityDevices();
    }
    if (url.pathname === "/security/devices/pending" && request.method === "GET") {
      return this.listPendingSecurityDevices();
    }
    if (url.pathname === "/security/events" && request.method === "GET") {
      return this.listSecurityEvents();
    }
    const securityDeviceAction = parseSecurityDeviceActionPath(url.pathname);
    if (securityDeviceAction && request.method === "POST") {
      if (await this.isLockedDown()) return json({ ok: false, error: "Remote access is locked" }, 423);
      return this.updateSecurityDevice(securityDeviceAction.deviceId, securityDeviceAction.action);
    }
    if (url.pathname === "/security/push-token" && request.method === "POST") {
      if (await this.isLockedDown()) return json({ ok: false, error: "Remote access is locked" }, 423);
      return this.registerPushToken(request);
    }
    if (url.pathname === "/security/test-push" && request.method === "POST") {
      if (await this.isLockedDown()) return json({ ok: false, error: "Remote access is locked" }, 423);
      return this.sendTestPush(request);
    }
    if (url.pathname === "/shares" && request.method === "GET") {
      return this.listShares(request);
    }
    if (url.pathname.startsWith("/shares/invite/") && url.pathname.endsWith("/accept")) {
      if (await this.isLockedDown()) return json({ ok: false, error: "Remote access is locked" }, 423);
      return this.acceptShareInvite(request, url);
    }
    if (url.pathname.startsWith("/shares/") && request.method === "GET") {
      return this.getShare(request, url);
    }
    if (url.pathname.startsWith("/shares/") && url.pathname.endsWith("/leave") && request.method === "POST") {
      return this.leaveShare(request, url);
    }
    if (url.pathname.startsWith("/shares/") && url.pathname.includes("/participants/") && request.method === "DELETE") {
      return this.removeShareParticipant(request, url);
    }
    if (url.pathname.startsWith("/shares/") && url.pathname.includes("/invites/") && request.method === "DELETE") {
      return this.revokeShareInvite(request, url);
    }
    if (url.pathname === "/shares/invite" && request.method === "POST") {
      if (await this.isLockedDown()) return json({ ok: false, error: "Remote access is locked" }, 423);
      return this.createShareInvite(request);
    }

    const upgradeHeader = request.headers.get("Upgrade")?.toLowerCase();
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const role = url.pathname === "/daemon/connect" ? "daemon" : "client";
    const securityState = await loadSecurityState(this.ctx.storage);
    if (isSecurityLockedDown(securityState)) {
      return new Response("Remote access is locked. Run `aimux security unlock` from your CLI.", { status: 423 });
    }
    if (role === "daemon") {
      const issuedAt = Number(request.headers.get("X-Aimux-Daemon-Iat") ?? "0");
      if (!Number.isFinite(issuedAt) || isDaemonTokenRevoked(securityState, issuedAt)) {
        return new Response("Daemon token has been revoked. Run `aimux security unlock`.", { status: 401 });
      }
    }

    let clientDevice: ReturnType<typeof sanitizeDeviceInfo> | null = null;
    let clientDeviceProof: VerifiedDeviceProof | undefined;
    let sharedClientTags: string[] = [];
    let sharedClientAuth: SharedClientAuth | undefined;
    if (role === "client") {
      try {
        clientDevice = sanitizeDeviceInfo({
          deviceId: url.searchParams.get("deviceId") ?? undefined,
          kind: url.searchParams.get("deviceKind") ?? undefined,
          name: url.searchParams.get("deviceName") ?? undefined,
          platform: url.searchParams.get("devicePlatform") ?? undefined,
          appVersion: url.searchParams.get("appVersion") ?? undefined,
        });
      } catch {
        return new Response("Missing or invalid deviceId", { status: 400 });
      }
      const shareId = url.searchParams.get("shareId")?.trim();
      if (shareId) {
        const sharedAuth = await this.authorizeSharedClientConnect(request, shareId);
        if (!sharedAuth.ok) return new Response(sharedAuth.error, { status: sharedAuth.status });
        sharedClientTags = [`share:${shareId}`, `user:${sharedAuth.userId}`];
        sharedClientAuth = sharedAuth;
      } else {
        const proofInput = deviceProofInputFromUrl(url);
        const proofResult = await verifyDeviceProof(
          securityState.devices[clientDevice.deviceId],
          clientDevice.deviceId,
          proofInput,
        );
        if (proofResult.ok) {
          clientDeviceProof = proofResult.proof;
        } else if (shouldEnforceDeviceProof(this.env.SECURITY_DEVICE_PROOF_POLICY)) {
          return new Response(`Invalid device proof: ${proofResult.reason}`, { status: 401 });
        }
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const daemonOwnerUserId = role === "daemon" ? request.headers.get("X-Aimux-User-Id")?.trim() : undefined;
    this.ctx.acceptWebSocket(
      server,
      clientDevice
        ? [role, `device:${clientDevice.deviceId}`, ...sharedClientTags]
        : daemonOwnerUserId
          ? [role, `user:${daemonOwnerUserId}`]
          : [role],
    );

    if (role === "daemon") {
      this.rehydrateSockets(server);
      if (this.daemonWs) {
        this.failPendingRequests("Daemon connection replaced", 502);
        this.failProjectEventSubscriptions("Daemon connection replaced", 502);
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
      if (clientDevice) this.clientDeviceIds.set(server, clientDevice.deviceId);
      this.send(server, { type: "connected", role: "client" });
      this.send(server, { type: "daemon_status", online: this.daemonWs !== null });
      await this.recordClientConnected(request, server, clientDevice!, sharedClientAuth, clientDeviceProof);
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

    if (isDaemon && parsed.type === "notification_push") {
      await this.handleDaemonNotificationPush(tags, parsed);
      return;
    }

    if (isDaemon && parsed.type === "project_event") {
      this.forwardProjectEvent(parsed);
      return;
    }

    if (isDaemon && (parsed.type === "project_events_subscribed" || parsed.type === "project_events_error")) {
      this.forwardProjectEventControl(parsed);
      return;
    }

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
    } else if (!isDaemon && parsed.type === "project_events_subscribe") {
      await this.handleClientProjectEventsSubscribe(ws, parsed);
    } else if (!isDaemon && parsed.type === "project_events_unsubscribe") {
      this.handleClientProjectEventsUnsubscribe(ws, parsed.id);
    } else if (!isDaemon && parsed.type === "request") {
      const sharedResult = await this.prepareSharedClientRequest(ws, parsed);
      if (!sharedResult.ok) {
        this.send(ws, {
          id: parsed.id,
          type: "response",
          status: sharedResult.status,
          body: { ok: false, error: sharedResult.error },
        });
        return;
      }
      if (await this.shouldRejectClientRequest(ws)) {
        const pendingDevice = await this.pendingSecurityDeviceForSocket(ws);
        const approvalCode = pendingDevice ? securityDeviceApprovalCode(pendingDevice) : undefined;
        this.send(ws, {
          id: parsed.id,
          type: "response",
          status: 403,
          body: {
            ok: false,
            error: approvalCode
              ? `Remote client pending security approval. Code ${approvalCode}.`
              : "Remote client pending security approval",
            deviceId: pendingDevice?.id,
            approvalCode,
          },
        });
        return;
      }
      if (this.daemonWs) {
        const relayRequestId = this.nextRelayRequestId();
        this.pendingRequests.set(relayRequestId, {
          client: ws,
          clientRequestId: parsed.id,
          expiresAt: Date.now() + PENDING_REQUEST_TTL_MS,
        });
        const daemonMessage = JSON.stringify({ ...parsed, ...sharedResult.requestPatch, id: relayRequestId });
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

  private async handleClientProjectEventsSubscribe(
    ws: WebSocket,
    message: Extract<RelayMessage, { type: "project_events_subscribe" }>,
  ): Promise<void> {
    const sharedResult = await this.prepareSharedClientRequest(ws, {
      id: message.id,
      type: "request",
      method: "GET",
      path: message.path,
      headers: message.headers,
    });
    if (!sharedResult.ok) {
      this.send(ws, {
        id: message.id,
        type: "project_events_error",
        status: sharedResult.status,
        message: sharedResult.error,
      });
      return;
    }
    if (await this.shouldRejectClientRequest(ws)) {
      const pendingDevice = await this.pendingSecurityDeviceForSocket(ws);
      this.send(ws, {
        id: message.id,
        type: "project_events_error",
        status: 403,
        message: pendingDevice
          ? `Remote client pending security approval. Code ${securityDeviceApprovalCode(pendingDevice)}.`
          : "Remote client pending security approval",
      });
      return;
    }
    if (!this.daemonWs) {
      this.send(ws, {
        id: message.id,
        type: "project_events_error",
        status: 503,
        message: "Daemon not connected",
      });
      return;
    }

    const relaySubscriptionId = this.nextRelayRequestId();
    this.eventSubscriptions.set(relaySubscriptionId, { client: ws, clientSubscriptionId: message.id });
    this.attachClientProjectEventSubscription(ws, relaySubscriptionId, message.id);
    try {
      this.daemonWs.send(
        JSON.stringify({
          id: relaySubscriptionId,
          type: "project_events_subscribe",
          path: message.path,
          headers: sharedResult.requestPatch?.headers ?? message.headers,
        }),
      );
    } catch {
      this.eventSubscriptions.delete(relaySubscriptionId);
      this.detachClientProjectEventSubscription(ws, relaySubscriptionId);
      this.send(ws, {
        id: message.id,
        type: "project_events_error",
        status: 502,
        message: "Daemon connection lost",
      });
    }
  }

  private handleClientProjectEventsUnsubscribe(ws: WebSocket, clientSubscriptionId: string): void {
    for (const [relaySubscriptionId, entry] of this.eventSubscriptions) {
      if (entry.client !== ws || entry.clientSubscriptionId !== clientSubscriptionId) continue;
      this.eventSubscriptions.delete(relaySubscriptionId);
      this.detachClientProjectEventSubscription(ws, relaySubscriptionId);
      this.sendDaemonProjectEventsUnsubscribe(relaySubscriptionId);
    }
  }

  private forwardProjectEvent(message: Extract<RelayMessage, { type: "project_event" }>): void {
    const subscription = this.eventSubscriptions.get(message.id);
    if (!subscription) return;
    try {
      subscription.client.send(JSON.stringify({ ...message, id: subscription.clientSubscriptionId }));
    } catch {
      this.eventSubscriptions.delete(message.id);
      this.detachClientProjectEventSubscription(subscription.client, message.id);
      this.sendDaemonProjectEventsUnsubscribe(message.id);
    }
  }

  private forwardProjectEventControl(
    message: Extract<RelayMessage, { type: "project_events_subscribed" | "project_events_error" }>,
  ): void {
    const subscription = this.eventSubscriptions.get(message.id);
    if (!subscription) return;
    if (message.type === "project_events_error") {
      this.eventSubscriptions.delete(message.id);
      this.detachClientProjectEventSubscription(subscription.client, message.id);
    }
    try {
      subscription.client.send(JSON.stringify({ ...message, id: subscription.clientSubscriptionId }));
    } catch {
      this.eventSubscriptions.delete(message.id);
      this.detachClientProjectEventSubscription(subscription.client, message.id);
      this.sendDaemonProjectEventsUnsubscribe(message.id);
    }
  }

  private async handleDaemonNotificationPush(
    tags: string[],
    message: Extract<RelayMessage, { type: "notification_push" }>,
  ): Promise<void> {
    const ownerUserId = tags.find((tag) => tag.startsWith("user:"))?.slice("user:".length);
    const notification = message.notification;
    if (!ownerUserId || !notification?.title) return;
    const state = await loadSecurityState(this.ctx.storage);
    try {
      await deliverNotificationPush({
        userId: ownerUserId,
        pushTokens: notificationPushTokensForDevicePolicy(state, this.env.SECURITY_DEVICE_POLICY),
        title: notification.title,
        body: notification.body,
        kind: notification.kind,
        sessionId: notification.sessionId,
        projectId: notification.projectId,
        projectRoot: notification.projectRoot,
        dedupeKey: notification.dedupeKey,
      });
    } catch (error) {
      console.error("notification push delivery failed", error);
    }
  }

  private async handleSecurityAction(request: Request, url: URL): Promise<Response> {
    const [, , , userId, token] = url.pathname.split("/");
    if (!userId || !token)
      return securityActionPage("Invalid security link", "This security action link is malformed.", 400);
    const state = await loadSecurityState(this.ctx.storage);
    const action = await findSecurityActionByToken(state, decodeURIComponent(token));
    if (!action || action.kind !== "emergency_lockdown") {
      return securityActionPage(
        "Security link expired",
        "This security action link is invalid, expired, or has already been used.",
        410,
      );
    }
    if (request.method === "GET") {
      return securityActionConfirmPage(decodeURIComponent(userId), decodeURIComponent(token));
    }
    if (request.method !== "POST") {
      return securityActionPage("Unsupported method", "Use the confirmation button from the security page.", 405);
    }

    let next = markSecurityActionUsed(state, action.id);
    next = activateSecurityLockdown(next, "Emergency lockdown triggered from a new-client security alert.");
    await saveSecurityState(this.ctx.storage, next);
    this.closeAllSockets("Security lockdown");
    return securityActionPage(
      "Remote access disabled",
      "All relay connections were closed and daemon tokens issued before this action were revoked. Run `aimux security unlock` from your CLI to re-enable remote access.",
      200,
    );
  }

  private async unlockSecurity(): Promise<Response> {
    const state = await loadSecurityState(this.ctx.storage);
    const next = deactivateSecurityLockdown(state, "Unlocked by an authenticated CLI login.");
    await saveSecurityState(this.ctx.storage, next);
    return json({ ok: true }, 200);
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
    const tags = this.ctx.getTags(ws);
    const wasKnownActiveDaemon = tags.includes("daemon") && this.daemonWs === ws;
    const closingProjectEventSubscriptionIds = tags.includes("client")
      ? Object.keys(this.clientSocketAttachment(ws).projectEventSubscriptions ?? {})
      : [];
    this.rehydrateSockets(ws);
    if (tags.includes("daemon") && (wasKnownActiveDaemon || !this.daemonWs)) {
      const replacementDaemon = this.daemonWs;
      // Fail every in-flight request immediately instead of waiting for
      // the TTL — the daemon that was going to answer just disappeared.
      this.failPendingRequests("Daemon connection lost", 502);
      this.failProjectEventSubscriptions("Daemon connection lost", 502);
      if (!replacementDaemon) {
        this.broadcastToClients({ type: "daemon_status", online: false });
      }
    } else {
      this.clientSockets.delete(ws);
      this.clientDeviceIds.delete(ws);
      for (const [id, entry] of this.pendingRequests) {
        if (entry.client === ws) this.pendingRequests.delete(id);
      }
      for (const id of closingProjectEventSubscriptionIds) {
        this.detachClientProjectEventSubscription(ws, id);
        this.sendDaemonProjectEventsUnsubscribe(id);
      }
    }
    try {
      ws.close(1000, "Closed");
    } catch {}
  }

  private broadcastToClients(msg: RelayMessage, exclude?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const client of this.clientSockets) {
      if (client === exclude) continue;
      try {
        client.send(data);
      } catch {
        this.clientSockets.delete(client);
      }
    }
  }

  private broadcastToOwnerClients(msg: RelayMessage, ownerUserId?: string, exclude?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const client of this.clientSockets) {
      if (client === exclude) continue;
      const tags = this.ctx.getTags(client);
      const shareTagged = tags.some((tag) => tag.startsWith("share:"));
      const ownerTagged = ownerUserId ? tags.includes(`user:${ownerUserId}`) : false;
      if (shareTagged && !ownerTagged) continue;
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

  private async recordClientConnected(
    request: Request,
    ws: WebSocket,
    device: ReturnType<typeof sanitizeDeviceInfo>,
    sharedClientAuth?: SharedClientAuth,
    deviceProof?: VerifiedDeviceProof,
  ): Promise<void> {
    const connectingUserId = request.headers.get("X-Aimux-User-Id") ?? "";
    const securityRecipientUserId = sharedClientAuth?.share.ownerUserId ?? connectingUserId;
    let state = await loadSecurityState(this.ctx.storage);
    if (deviceProof) {
      const existingDevice = state.devices[device.deviceId];
      if (!deviceProofMatchesRecord(existingDevice, deviceProof)) {
        try {
          ws.close(1008, "Device proof key mismatch");
        } catch {}
        return;
      }
      const nonceResult = consumeDeviceProofNonce(state, device.deviceId, deviceProof);
      if (!nonceResult.ok) {
        try {
          ws.close(1008, nonceResult.reason);
        } catch {}
        return;
      }
      state = nonceResult.state;
    }
    const ipHash = await hashIpAddress(request.headers.get("CF-Connecting-IP"), this.env.SECURITY_IP_HASH_SECRET);
    const context = {
      ipHash,
      country: request.headers.get("CF-IPCountry") ?? undefined,
      userAgent: request.headers.get("User-Agent") ?? undefined,
      deviceProof,
      shared: sharedClientAuth
        ? {
            shareId: sharedClientAuth.share.id,
            sessionId: sharedClientAuth.share.sessionId,
            actorUserId: sharedClientAuth.participant.userId,
            actorName: sharedClientAuth.participant.displayName,
            actorEmail: sharedClientAuth.participant.email,
          }
        : undefined,
    };
    let result: ReturnType<typeof recordClientConnection>;
    try {
      result = recordClientConnection(state, device, context);
    } catch (error) {
      try {
        ws.close(1008, error instanceof Error ? error.message : "Device proof rejected");
      } catch {}
      return;
    }
    let emergencyUrl: string | undefined;
    if (result.firstSeen && securityRecipientUserId && !sharedClientAuth) {
      const action = await createSecurityActionToken("emergency_lockdown", { deviceId: result.device.id });
      result.state.actions[action.action.id] = action.action;
      emergencyUrl = `${this.securityActionBaseUrl(request)}/security/action/${encodeURIComponent(securityRecipientUserId)}/${encodeURIComponent(action.token)}`;
    }
    await saveSecurityState(this.ctx.storage, result.state);
    for (const event of result.events) {
      if (this.daemonWs) {
        try {
          this.send(this.daemonWs, { type: "security_event", event });
        } catch {}
      }
      if (event.kind === "new_client_detected") {
        try {
          this.send(ws, { type: "security_event", event });
        } catch {}
      }
      if (event.kind === "new_client_detected" || event.kind === "shared_client_connected") {
        this.broadcastToOwnerClients({ type: "security_event", event }, securityRecipientUserId, ws);
        await deliverSecurityAlert({
          env: this.env,
          userId: securityRecipientUserId,
          event,
          device: result.device,
          pushTokens: Object.values(result.state.pushTokens),
          emergencyUrl,
        });
      }
    }
  }

  private async registerPushToken(request: Request): Promise<Response> {
    let body: {
      deviceId?: string;
      deviceKind?: string;
      deviceName?: string;
      devicePlatform?: string;
      appVersion?: string;
      deviceProof?: DeviceProofInput;
      token?: string;
      platform?: "ios" | "android" | "web" | "unknown";
      agentAlerts?: boolean;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }
    const deviceId = body.deviceId?.trim();
    const token = body.token?.trim();
    if (!deviceId || !token) {
      return json({ ok: false, error: "Missing deviceId or token" }, 400);
    }
    const now = new Date().toISOString();
    let state = await loadSecurityState(this.ctx.storage);
    const userId = request.headers.get("X-Aimux-User-Id")?.trim() || undefined;
    const ownerUserId = request.headers.get("X-Aimux-Share-Owner-Id")?.trim();
    const shareId = request.headers.get("X-Aimux-Share-Id")?.trim();
    const deviceInfo = sanitizeDeviceInfo({
      deviceId,
      kind: body.deviceKind ?? body.platform,
      name: body.deviceName,
      platform: body.devicePlatform ?? body.platform,
      appVersion: body.appVersion,
    });
    if (ownerUserId || shareId) {
      if (!userId || !ownerUserId || !shareId) {
        return json({ ok: false, error: "Missing shared push registration context" }, 401);
      }
      const sharingState = await loadSharingState(this.ctx.storage);
      const share = sharingState.shares[shareId];
      if (!share || share.ownerUserId !== ownerUserId) {
        return json({ ok: false, error: "Shared chat not found" }, 404);
      }
      const participant = share.participants[userId];
      if (!participant || participant.status !== "active") {
        return json({ ok: false, error: "Not a participant in this shared chat" }, 403);
      }
    } else {
      const proofResult = await verifyDeviceProof(
        state.devices[deviceInfo.deviceId],
        deviceInfo.deviceId,
        body.deviceProof ?? {},
      );
      if (!proofResult.ok) {
        if (shouldEnforceDeviceProof(this.env.SECURITY_DEVICE_PROOF_POLICY)) {
          return json({ ok: false, error: `Invalid device proof: ${proofResult.reason}` }, 401);
        }
      } else {
        const nonceResult = consumeDeviceProofNonce(state, deviceInfo.deviceId, proofResult.proof);
        if (!nonceResult.ok) return json({ ok: false, error: nonceResult.reason }, 401);
        state = nonceResult.state;
        try {
          state = recordClientConnection(state, deviceInfo, { deviceProof: proofResult.proof }, now).state;
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : "Device proof rejected" }, 401);
        }
      }
    }
    const tokenKey = userId ? `${userId}:${deviceInfo.deviceId}` : deviceInfo.deviceId;
    const createdAt = state.pushTokens[tokenKey]?.createdAt ?? state.pushTokens[deviceInfo.deviceId]?.createdAt ?? now;
    if (userId && state.pushTokens[deviceInfo.deviceId]) {
      delete state.pushTokens[deviceInfo.deviceId];
    }
    state.pushTokens[tokenKey] = {
      userId,
      deviceId: deviceInfo.deviceId,
      token,
      platform: body.platform ?? "unknown",
      agentAlerts: body.agentAlerts !== false,
      createdAt,
      updatedAt: now,
    };
    await saveSecurityState(this.ctx.storage, state);
    return json({ ok: true }, 200);
  }

  private async listSecurityDevices(): Promise<Response> {
    const state = await loadSecurityState(this.ctx.storage);
    const devices = Object.values(state.devices)
      .filter((device) => !device.id.startsWith("shared:"))
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .map((device) => this.securityDeviceResponse(device));
    return json({ ok: true, devices }, 200);
  }

  private async listPendingSecurityDevices(): Promise<Response> {
    const state = await loadSecurityState(this.ctx.storage);
    const liveIds = this.liveOwnerDeviceIds();
    const devices = [...liveIds]
      .map((deviceId) => state.devices[deviceId])
      .filter((device) => device && !isDeviceApproved(device) && !device.blockedAt)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .map((device) => this.securityDeviceResponse(device, { includeApprovalCode: true }));
    return json({ ok: true, devices }, 200);
  }

  private securityDeviceResponse(
    device: SecurityDeviceRecord,
    opts: { includeApprovalCode?: boolean } = {},
  ): SecurityDeviceRecord & { approved: boolean; blocked: boolean; approvalCode?: string } {
    return {
      ...device,
      approved: isDeviceApproved(device),
      blocked: Boolean(device.blockedAt),
      approvalCode: opts.includeApprovalCode ? securityDeviceApprovalCode(device) : undefined,
    };
  }

  private async listSecurityEvents(): Promise<Response> {
    const state = await loadSecurityState(this.ctx.storage);
    return json({ ok: true, events: state.events }, 200);
  }

  private async updateSecurityDevice(deviceId: string, action: "approve" | "block" | "unblock"): Promise<Response> {
    const state = await loadSecurityState(this.ctx.storage);
    if (action === "approve" && !this.isLivePendingSecurityDevice(state, deviceId)) {
      return json({ ok: false, error: "Device is not currently connected and waiting for approval" }, 409);
    }
    let event: SecurityEventRecord | null = null;
    const result = (() => {
      if (action === "approve") {
        const approved = approveSecurityDevice(state, deviceId);
        event = approved.event;
        return { state: approved.state, device: approved.device };
      }
      if (action === "block") {
        const blocked = blockSecurityDevice(state, deviceId);
        event = blocked.event;
        return { state: blocked.state, device: blocked.device };
      }
      return unblockSecurityDevice(state, deviceId);
    })();
    if (!result.device) return json({ ok: false, error: "Device not found" }, 404);
    await saveSecurityState(this.ctx.storage, result.state);
    if (event) {
      this.broadcastToClients({ type: "security_event", event });
      if (this.daemonWs) {
        try {
          this.send(this.daemonWs, { type: "security_event", event });
        } catch {}
      }
    }
    if (action === "block") this.closeClientSocketsForDevice(result.device.id, "Remote device blocked");
    return json(
      {
        ok: true,
        device: this.securityDeviceResponse(result.device),
      },
      200,
    );
  }

  private async sendTestPush(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Aimux-User-Id")?.trim();
    if (!userId) return json({ ok: false, error: "Missing authorization" }, 401);
    const state = await loadSecurityState(this.ctx.storage);
    const pushTokens = Object.values(state.pushTokens).filter(
      (record) =>
        record.userId === userId &&
        (record.platform === "ios" || record.platform === "android") &&
        record.agentAlerts !== false,
    );
    if (pushTokens.length === 0) {
      return json({ ok: false, error: "No enabled mobile push token registered" }, 404);
    }
    await deliverNotificationPush({
      userId,
      pushTokens,
      title: "aimux test notification",
      body: "Push notifications are working.",
      kind: "test",
      dedupeKey: `test:${Date.now()}`,
    });
    return json({ ok: true }, 200);
  }

  private async authorizeSharedClientConnect(
    request: Request,
    shareId: string,
  ): Promise<({ ok: true } & SharedClientAuth) | { ok: false; status: number; error: string }> {
    const userId = request.headers.get("X-Aimux-User-Id")?.trim();
    const ownerUserId = request.headers.get("X-Aimux-Share-Owner-Id")?.trim();
    if (!userId || !ownerUserId) return { ok: false, status: 401, error: "Missing share user context" };
    const state = await loadSharingState(this.ctx.storage);
    const share = state.shares[shareId];
    if (!share || share.ownerUserId !== ownerUserId) {
      return { ok: false, status: 404, error: "Shared chat not found" };
    }
    const participant = share.participants[userId];
    if (!participant || participant.status !== "active") {
      return { ok: false, status: 403, error: "Not a participant in this shared chat" };
    }
    return { ok: true, userId, share, participant };
  }

  private async prepareSharedClientRequest(
    ws: WebSocket,
    request: Extract<RelayMessage, { type: "request" }>,
  ): Promise<
    { ok: true; requestPatch?: { headers?: Record<string, string> } } | { ok: false; status: number; error: string }
  > {
    const tags = this.ctx.getTags(ws);
    const shareId = tagValue(tags, "share:");
    if (!shareId) return { ok: true };
    const userId = tagValue(tags, "user:");
    if (!userId) return { ok: false, status: 401, error: "Missing shared user context" };
    const state = await loadSharingState(this.ctx.storage);
    const share = state.shares[shareId];
    if (!share) return { ok: false, status: 404, error: "Shared chat not found" };
    const participant = share.participants[userId];
    if (!participant || participant.status !== "active") {
      return { ok: false, status: 403, error: "Not a participant in this shared chat" };
    }
    const access = sharedRelayRequestAccess(request, share);
    if (!access.allowed) {
      return { ok: false, status: 403, error: "Route is not allowed for this shared chat" };
    }
    return {
      ok: true,
      requestPatch: {
        headers: {
          ...stripTrustedAimuxHeaders(request.headers),
          "X-Aimux-Share-Id": share.id,
          "X-Aimux-Share-Session-Id": share.sessionId,
          "X-Aimux-Share-Mode": getShareChatMode(share),
          "X-Aimux-Actor-User-Id": participant.userId,
          "X-Aimux-Actor-Name": participant.displayName,
          "X-Aimux-Actor-Role": participant.role,
          ...(participant.email ? { "X-Aimux-Actor-Email": participant.email } : {}),
        },
      },
    };
  }

  private async listShares(request: Request): Promise<Response> {
    const userId = request.headers.get("X-Aimux-User-Id") ?? "";
    if (!userId) return json({ ok: false, error: "Missing user context" }, 401);
    const state = await loadSharingState(this.ctx.storage);
    const sharesByKey = new Map<string, SharedSessionSummary>();
    for (const share of listAcceptedShares(state)) {
      sharesByKey.set(`${share.ownerUserId}:${share.id}`, share);
    }
    for (const share of Object.values(state.shares)
      .filter((share) => share.ownerUserId === userId || share.participants[userId]?.status === "active")
      .map(summarizeShare)) {
      sharesByKey.set(`${share.ownerUserId}:${share.id}`, share);
    }
    const shares = [...sharesByKey.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return json({ ok: true, shares }, 200);
  }

  private async upsertAcceptedShareIndex(request: Request): Promise<Response> {
    let body: { share?: SharedSessionSummary };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }
    if (!body.share) return json({ ok: false, error: "Missing share" }, 400);
    const state = await loadSharingState(this.ctx.storage);
    await saveSharingState(this.ctx.storage, upsertAcceptedShare(state, body.share));
    return json({ ok: true }, 200);
  }

  private async removeAcceptedShareIndex(request: Request): Promise<Response> {
    let body: { ownerUserId?: string; shareId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }
    if (!body.ownerUserId || !body.shareId) return json({ ok: false, error: "Missing share reference" }, 400);
    const state = await loadSharingState(this.ctx.storage);
    await saveSharingState(this.ctx.storage, removeAcceptedShare(state, body.ownerUserId, body.shareId));
    return json({ ok: true }, 200);
  }

  private async getShare(request: Request, url: URL): Promise<Response> {
    const actor = this.actorFromHeaders(request, "guest");
    if (!actor) return json({ ok: false, error: "Missing user context" }, 401);
    const parsed = parseOwnerSharePath(url.pathname);
    if (!parsed) return json({ ok: false, error: "Invalid share URL" }, 400);
    const state = await loadSharingState(this.ctx.storage);
    const share = state.shares[parsed.shareId];
    if (!share || share.ownerUserId !== parsed.ownerUserId) return json({ ok: false, error: "Share not found" }, 404);
    if (!canReadShare(share, actor.userId))
      return json({ ok: false, error: "Not a participant in this shared chat" }, 403);
    const summary = summarizeShare(share);
    if (actor.userId !== share.ownerUserId) {
      try {
        await this.upsertShareInReceiverIndex(actor.userId, summary);
      } catch (error) {
        console.warn("accepted share index repair failed:", error);
      }
    }
    return json({ ok: true, share: summary }, 200);
  }

  private async leaveShare(request: Request, url: URL): Promise<Response> {
    const actor = this.actorFromHeaders(request, "guest");
    if (!actor) return json({ ok: false, error: "Missing user context" }, 401);
    const parsed = parseOwnerSharePath(url.pathname.replace(/\/leave$/, ""));
    if (!parsed) return json({ ok: false, error: "Invalid share URL" }, 400);
    const state = await loadSharingState(this.ctx.storage);
    const share = state.shares[parsed.shareId];
    if (!share || share.ownerUserId !== parsed.ownerUserId) return json({ ok: false, error: "Share not found" }, 404);
    if (share.ownerUserId === actor.userId)
      return json({ ok: false, error: "Owner cannot leave their own share" }, 400);
    if (share.participants[actor.userId]?.status !== "active") {
      return json({ ok: false, error: "Not a participant in this shared chat" }, 403);
    }
    const result = removeShareParticipant(state, share.id, actor.userId);
    await saveSharingState(this.ctx.storage, result.state);
    await this.removeShareFromReceiverIndex(actor.userId, share.ownerUserId, share.id);
    const event = createShareSecurityEvent({
      kind: "shared_participant_left",
      shareId: share.id,
      sessionId: share.sessionId,
      actor,
    });
    await this.recordAndDeliverShareSecurityEvent(request, event, {
      ownerUserId: share.ownerUserId,
      broadcast: true,
      deliverToOwner: true,
    });
    return json({ ok: true, share: summarizeShare(result.share ?? share) }, 200);
  }

  private async removeShareParticipant(request: Request, url: URL): Promise<Response> {
    const actor = this.actorFromHeaders(request, "owner");
    if (!actor) return json({ ok: false, error: "Missing user context" }, 401);
    const parsed = parseParticipantPath(url.pathname);
    if (!parsed) return json({ ok: false, error: "Invalid participant URL" }, 400);
    const state = await loadSharingState(this.ctx.storage);
    const share = state.shares[parsed.shareId];
    if (!share || share.ownerUserId !== parsed.ownerUserId) return json({ ok: false, error: "Share not found" }, 404);
    if (share.ownerUserId !== actor.userId) return json({ ok: false, error: "Only the owner can remove guests" }, 403);
    if (parsed.participantUserId === share.ownerUserId)
      return json({ ok: false, error: "Owner cannot be removed" }, 400);
    if (!share.participants[parsed.participantUserId]) {
      return json({ ok: false, error: "Participant not found" }, 404);
    }
    const target = share.participants[parsed.participantUserId]!;
    const result = removeShareParticipant(state, share.id, parsed.participantUserId);
    await saveSharingState(this.ctx.storage, result.state);
    await this.removeShareFromReceiverIndex(target.userId, share.ownerUserId, share.id);
    const event = createShareSecurityEvent({
      kind: "shared_participant_removed",
      shareId: share.id,
      sessionId: share.sessionId,
      actor,
      target,
    });
    await this.recordAndDeliverShareSecurityEvent(request, event, {
      ownerUserId: share.ownerUserId,
      broadcast: true,
      deliverToOwner: true,
      deliverToUserId: target.userId,
    });
    this.closeClientSocketsForUser(target.userId, "Shared chat access removed");
    return json({ ok: true, share: summarizeShare(result.share ?? share) }, 200);
  }

  private async revokeShareInvite(request: Request, url: URL): Promise<Response> {
    const actor = this.actorFromHeaders(request, "owner");
    if (!actor) return json({ ok: false, error: "Missing user context" }, 401);
    const parsed = parseInvitePath(url.pathname);
    if (!parsed) return json({ ok: false, error: "Invalid invite URL" }, 400);
    const state = await loadSharingState(this.ctx.storage);
    const share = state.shares[parsed.shareId];
    if (!share || share.ownerUserId !== parsed.ownerUserId) return json({ ok: false, error: "Share not found" }, 404);
    if (share.ownerUserId !== actor.userId) return json({ ok: false, error: "Only the owner can revoke invites" }, 403);
    if (!share.invites[parsed.inviteId]) return json({ ok: false, error: "Invite not found" }, 404);
    const result = revokeShareInvite(state, share.id, parsed.inviteId);
    await saveSharingState(this.ctx.storage, result.state);
    return json({ ok: true, share: summarizeShare(result.share ?? share) }, 200);
  }

  private async createShareInvite(request: Request): Promise<Response> {
    const owner = this.actorFromHeaders(request, "owner");
    if (!owner) return json({ ok: false, error: "Missing owner context" }, 401);
    let body: {
      projectRoot?: string;
      serviceEndpoint?: { host?: string; port?: number };
      sessionId?: string;
      email?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }
    const state = await loadSharingState(this.ctx.storage);
    try {
      const result = await createShareInvite(state, {
        owner,
        projectRoot: body.projectRoot ?? "",
        serviceEndpoint: body.serviceEndpoint
          ? { host: body.serviceEndpoint.host ?? "", port: Number(body.serviceEndpoint.port) }
          : undefined,
        sessionId: body.sessionId ?? "",
        email: body.email ?? "",
      });
      await saveSharingState(this.ctx.storage, result.state);
      const acceptUrl = `${this.shareInviteBaseUrl(request)}/shares/invite/${encodeURIComponent(owner.userId)}/${encodeURIComponent(result.token.token)}/accept`;
      let emailDelivered = false;
      try {
        emailDelivered = await deliverShareInvite({
          env: this.env,
          owner,
          share: result.token.share,
          inviteEmail: result.token.invite.email,
          acceptUrl,
        });
      } catch {
        emailDelivered = false;
      }
      return json(
        {
          ok: true,
          emailDelivered,
          share: summarizeShare(result.token.share),
          invite: {
            ...result.token.invite,
            tokenHash: undefined,
          },
          acceptUrl,
        },
        201,
      );
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private async acceptShareInvite(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST") return json({ ok: false, error: "Unsupported method" }, 405);
    const actor = this.actorFromHeaders(request, "guest");
    if (!actor) return json({ ok: false, error: "Missing user context" }, 401);
    if (!actor.email) return json({ ok: false, error: "Authenticated user has no email" }, 403);
    const match = url.pathname.match(/^\/shares\/invite\/([^/]+)\/([^/]+)\/accept$/);
    const ownerUserId = match ? decodeURIComponent(match[1]) : "";
    const token = match ? decodeURIComponent(match[2]) : "";
    if (!ownerUserId || !token) return json({ ok: false, error: "Invalid invite URL" }, 400);
    const state = await loadSharingState(this.ctx.storage);
    try {
      const result = await acceptShareInvite(state, { token, actor });
      if (result.share.ownerUserId !== ownerUserId) {
        return json({ ok: false, error: "Invite owner mismatch" }, 403);
      }
      await saveSharingState(this.ctx.storage, result.state);
      await this.upsertShareInReceiverIndex(actor.userId, summarizeShare(result.share));
      const event = createShareSecurityEvent({
        kind: "shared_invite_accepted",
        shareId: result.share.id,
        sessionId: result.share.sessionId,
        actor,
      });
      await this.recordAndDeliverShareSecurityEvent(request, event, {
        ownerUserId: result.share.ownerUserId,
        broadcast: true,
        deliverToOwner: true,
        emergencyLockdown: true,
      });
      return json({ ok: true, share: summarizeShare(result.share), participant: result.participant }, 200);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private actorFromHeaders(request: Request, role: "owner" | "guest") {
    const userId = request.headers.get("X-Aimux-User-Id")?.trim();
    if (!userId) return null;
    const displayName = request.headers.get("X-Aimux-User-Name")?.trim() || userId;
    const email = request.headers.get("X-Aimux-User-Email")?.trim() || undefined;
    return { userId, displayName, email, role };
  }

  private securityActionBaseUrl(request: Request): string {
    return (this.env.SECURITY_ACTION_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, "");
  }

  private shareInviteBaseUrl(request: Request): string {
    return (this.env.SHARE_INVITE_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, "");
  }

  private async upsertShareInReceiverIndex(userId: string, share: SharedSessionSummary): Promise<void> {
    const relayId = this.env.RELAY.idFromName(userId);
    const stub = this.env.RELAY.get(relayId);
    const response = await stub.fetch("https://internal.aimux.local/internal/accepted-shares/upsert", {
      method: "POST",
      body: JSON.stringify({ share }),
    });
    if (!response.ok) {
      throw new Error(`Accepted share index upsert failed with ${response.status}`);
    }
  }

  private async removeShareFromReceiverIndex(userId: string, ownerUserId: string, shareId: string): Promise<void> {
    try {
      const relayId = this.env.RELAY.idFromName(userId);
      const stub = this.env.RELAY.get(relayId);
      await stub.fetch("https://internal.aimux.local/internal/accepted-shares/remove", {
        method: "POST",
        body: JSON.stringify({ ownerUserId, shareId }),
      });
    } catch {
      // Revocation is enforced by the canonical owner share even if a stale list row remains briefly.
    }
  }

  private async isLockedDown(): Promise<boolean> {
    const state = await loadSecurityState(this.ctx.storage);
    return isSecurityLockedDown(state);
  }

  private async shouldRejectClientRequest(ws: WebSocket): Promise<boolean> {
    if (this.env.SECURITY_DEVICE_POLICY !== "enforce") return false;
    const tags = this.ctx.getTags(ws);
    if (tags.some((tag) => tag.startsWith("share:"))) return false;
    const deviceId = this.clientDeviceIds.get(ws) ?? this.deviceIdFromTags(ws);
    if (!deviceId) return true;
    const state = await loadSecurityState(this.ctx.storage);
    return !isDeviceApproved(state.devices[deviceId]);
  }

  private async pendingSecurityDeviceForSocket(ws: WebSocket): Promise<SecurityDeviceRecord | null> {
    const deviceId = this.clientDeviceIds.get(ws) ?? this.deviceIdFromTags(ws);
    if (!deviceId) return null;
    const state = await loadSecurityState(this.ctx.storage);
    const device = state.devices[deviceId];
    if (!device || isDeviceApproved(device) || device.blockedAt) return null;
    return device;
  }

  private isLivePendingSecurityDevice(state: Awaited<ReturnType<typeof loadSecurityState>>, deviceId: string): boolean {
    const device = state.devices[deviceId];
    return Boolean(device && this.liveOwnerDeviceIds().has(deviceId) && !isDeviceApproved(device) && !device.blockedAt);
  }

  private liveOwnerDeviceIds(): Set<string> {
    this.rehydrateSockets();
    const ids = new Set<string>();
    for (const ws of this.clientSockets) {
      const tags = this.ctx.getTags(ws);
      if (tags.some((tag) => tag.startsWith("share:"))) continue;
      const deviceId = this.clientDeviceIds.get(ws) ?? this.deviceIdFromTags(ws);
      if (deviceId) ids.add(deviceId);
    }
    return ids;
  }

  private async recordAndDeliverShareSecurityEvent(
    request: Request,
    event: SecurityEventRecord,
    options: {
      ownerUserId: string;
      broadcast?: boolean;
      deliverToOwner?: boolean;
      deliverToUserId?: string;
      emergencyLockdown?: boolean;
    },
  ): Promise<void> {
    const state = await loadSecurityState(this.ctx.storage);
    let emergencyUrl: string | undefined;
    if (options.emergencyLockdown && options.ownerUserId) {
      const action = await createSecurityActionToken("emergency_lockdown");
      state.actions[action.action.id] = action.action;
      emergencyUrl = `${this.securityActionBaseUrl(request)}/security/action/${encodeURIComponent(options.ownerUserId)}/${encodeURIComponent(action.token)}`;
    }
    appendSecurityEvent(state, event);
    await saveSecurityState(this.ctx.storage, state);

    if (options.broadcast) {
      this.broadcastToClients({ type: "security_event", event });
      if (this.daemonWs) {
        try {
          this.send(this.daemonWs, { type: "security_event", event });
        } catch {}
      }
    }

    const pushTokens = Object.values(state.pushTokens);
    if (options.deliverToOwner) {
      await deliverSecurityAlert({
        env: this.env,
        userId: options.ownerUserId,
        event,
        pushTokens,
        emergencyUrl,
      });
    }
    if (options.deliverToUserId && options.deliverToUserId !== options.ownerUserId) {
      await deliverSecurityAlert({
        env: this.env,
        userId: options.deliverToUserId,
        event,
        pushTokens,
      });
    }
  }

  private ensureHeartbeat(): void {
    this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  private rehydrateSockets(exclude?: WebSocket): void {
    this.daemonWs = null;
    this.clientSockets.clear();
    this.clientDeviceIds.clear();
    this.eventSubscriptions.clear();
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
        const deviceId = this.deviceIdFromTags(ws);
        if (deviceId) this.clientDeviceIds.set(ws, deviceId);
        for (const [relaySubscriptionId, clientSubscriptionId] of Object.entries(
          this.clientSocketAttachment(ws).projectEventSubscriptions ?? {},
        )) {
          this.eventSubscriptions.set(relaySubscriptionId, { client: ws, clientSubscriptionId });
        }
      }
    }
  }

  private deviceIdFromTags(ws: WebSocket): string | undefined {
    const deviceTag = this.ctx.getTags(ws).find((tag) => tag.startsWith("device:"));
    return deviceTag?.slice("device:".length);
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

  private failProjectEventSubscriptions(message: string, status: number): void {
    for (const [, entry] of this.eventSubscriptions) {
      try {
        entry.client.send(
          JSON.stringify({
            id: entry.clientSubscriptionId,
            type: "project_events_error",
            status,
            message,
          }),
        );
      } catch {}
      this.clearClientProjectEventSubscriptions(entry.client);
    }
    this.eventSubscriptions.clear();
  }

  private sendDaemonProjectEventsUnsubscribe(id: string): void {
    if (!this.daemonWs) return;
    try {
      this.send(this.daemonWs, { id, type: "project_events_unsubscribe" });
    } catch {}
  }

  private clientSocketAttachment(ws: WebSocket): ClientSocketAttachment {
    const socketWithAttachment = ws as WebSocket & {
      deserializeAttachment?: () => unknown;
    };
    const attachment = socketWithAttachment.deserializeAttachment?.();
    if (!attachment || typeof attachment !== "object") return {};
    return attachment as ClientSocketAttachment;
  }

  private saveClientSocketAttachment(ws: WebSocket, attachment: ClientSocketAttachment): void {
    const socketWithAttachment = ws as WebSocket & {
      serializeAttachment?: (value: unknown) => void;
    };
    socketWithAttachment.serializeAttachment?.(attachment);
  }

  private attachClientProjectEventSubscription(
    ws: WebSocket,
    relaySubscriptionId: string,
    clientSubscriptionId: string,
  ): void {
    const attachment = this.clientSocketAttachment(ws);
    this.saveClientSocketAttachment(ws, {
      ...attachment,
      projectEventSubscriptions: {
        ...(attachment.projectEventSubscriptions ?? {}),
        [relaySubscriptionId]: clientSubscriptionId,
      },
    });
  }

  private detachClientProjectEventSubscription(ws: WebSocket, relaySubscriptionId: string): void {
    const attachment = this.clientSocketAttachment(ws);
    const subscriptions = { ...(attachment.projectEventSubscriptions ?? {}) };
    delete subscriptions[relaySubscriptionId];
    this.saveClientSocketAttachment(ws, {
      ...attachment,
      projectEventSubscriptions: Object.keys(subscriptions).length > 0 ? subscriptions : undefined,
    });
  }

  private clearClientProjectEventSubscriptions(ws: WebSocket): void {
    const attachment = this.clientSocketAttachment(ws);
    this.saveClientSocketAttachment(ws, { ...attachment, projectEventSubscriptions: undefined });
  }

  private closeAllSockets(reason: string): void {
    this.failPendingRequests(reason, 423);
    this.failProjectEventSubscriptions(reason, 423);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1008, reason);
      } catch {}
    }
    this.daemonWs = null;
    this.clientSockets.clear();
    this.clientDeviceIds.clear();
  }

  private closeClientSocketsForUser(userId: string, reason: string): void {
    for (const ws of this.clientSockets) {
      const tags = this.ctx.getTags(ws);
      if (!tags.includes(`user:${userId}`)) continue;
      try {
        ws.close(1008, reason);
      } catch {}
      this.clientSockets.delete(ws);
      this.clientDeviceIds.delete(ws);
    }
  }

  private closeClientSocketsForDevice(deviceId: string, reason: string): void {
    for (const ws of this.clientSockets) {
      const tags = this.ctx.getTags(ws);
      if (!tags.includes(`device:${deviceId}`)) continue;
      try {
        ws.close(1008, reason);
      } catch {}
      this.clientSockets.delete(ws);
      this.clientDeviceIds.delete(ws);
    }
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tagValue(tags: string[], prefix: string): string | undefined {
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function securityActionConfirmPage(userId: string, token: string): Response {
  const actionPath = `/security/action/${encodeURIComponent(userId)}/${encodeURIComponent(token)}`;
  return html(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Disable aimux remote access</title>
    <style>${securityActionCss()}</style>
  </head>
  <body>
    <main>
      <h1>Disable aimux remote access?</h1>
      <p>This will immediately close relay connections and revoke daemon tokens issued before this alert.</p>
      <p>Use this if you do not recognize the new remote client.</p>
      <form method="post" action="${escapeHtml(actionPath)}">
        <button type="submit">Disable remote access</button>
      </form>
    </main>
  </body>
</html>`,
    200,
  );
}

function securityActionPage(title: string, body: string, status: number): Response {
  return html(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${securityActionCss()}</style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
    </main>
  </body>
</html>`,
    status,
  );
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function parseOwnerSharePath(pathname: string): { ownerUserId: string; shareId: string } | null {
  const match = pathname.match(/^\/shares\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return {
    ownerUserId: decodeURIComponent(match[1]),
    shareId: decodeURIComponent(match[2]),
  };
}

function parseSecurityDeviceActionPath(
  pathname: string,
): { deviceId: string; action: "approve" | "block" | "unblock" } | null {
  const match = pathname.match(/^\/security\/devices\/([^/]+)\/(approve|block|unblock)$/);
  if (!match) return null;
  return {
    deviceId: decodeURIComponent(match[1]),
    action: match[2] as "approve" | "block" | "unblock",
  };
}

function deviceProofInputFromUrl(url: URL): {
  alg?: string | null;
  publicKeyJwk?: unknown;
  timestamp?: string | null;
  nonce?: string | null;
  signature?: string | null;
} {
  const encodedPublicKey = url.searchParams.get("devicePublicKey");
  let publicKeyJwk: unknown;
  if (encodedPublicKey) {
    try {
      publicKeyJwk = JSON.parse(base64UrlDecodeToText(encodedPublicKey));
    } catch {
      publicKeyJwk = undefined;
    }
  }
  return {
    alg: url.searchParams.get("deviceKeyAlg"),
    publicKeyJwk,
    timestamp: url.searchParams.get("deviceProofTs"),
    nonce: url.searchParams.get("deviceProofNonce"),
    signature: url.searchParams.get("deviceProof"),
  };
}

function base64UrlDecodeToText(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseParticipantPath(pathname: string): {
  ownerUserId: string;
  shareId: string;
  participantUserId: string;
} | null {
  const match = pathname.match(/^\/shares\/([^/]+)\/([^/]+)\/participants\/([^/]+)$/);
  if (!match) return null;
  return {
    ownerUserId: decodeURIComponent(match[1]),
    shareId: decodeURIComponent(match[2]),
    participantUserId: decodeURIComponent(match[3]),
  };
}

function parseInvitePath(pathname: string): { ownerUserId: string; shareId: string; inviteId: string } | null {
  const match = pathname.match(/^\/shares\/([^/]+)\/([^/]+)\/invites\/([^/]+)$/);
  if (!match) return null;
  return {
    ownerUserId: decodeURIComponent(match[1]),
    shareId: decodeURIComponent(match[2]),
    inviteId: decodeURIComponent(match[3]),
  };
}

function canReadShare(share: SharedSessionRecord, userId: string): boolean {
  return share.ownerUserId === userId || share.participants[userId]?.status === "active";
}

function securityActionCss(): string {
  return "body{margin:0;background:#09090b;color:#fafafa;font-family:system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:520px;margin:18vh auto;padding:0 24px;line-height:1.5}h1{font-size:28px;margin:0 0 12px}p{color:#c4c4c7}button{border:0;border-radius:8px;background:#dc2626;color:white;font-weight:700;font-size:15px;padding:12px 16px;cursor:pointer}";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
