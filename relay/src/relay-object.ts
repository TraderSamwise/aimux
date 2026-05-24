import { DurableObject } from "cloudflare:workers";
import type { Env, RelayMessage } from "./types.js";
import { deliverSecurityAlert } from "./security-delivery.js";
import { deliverShareInvite } from "./sharing-delivery.js";
import {
  activateSecurityLockdown,
  createSecurityActionToken,
  deactivateSecurityLockdown,
  findSecurityActionByToken,
  hashIpAddress,
  isDaemonTokenRevoked,
  isDeviceApproved,
  isSecurityLockedDown,
  loadSecurityState,
  markSecurityActionUsed,
  recordClientConnection,
  sanitizeDeviceInfo,
  saveSecurityState,
} from "./security.js";
import {
  acceptShareInvite,
  createShareInvite,
  getShareChatMode,
  loadSharingState,
  removeShareParticipant,
  saveSharingState,
  sharedRelayRequestAccess,
  summarizeShare,
  stripTrustedAimuxHeaders,
} from "./sharing.js";
import type { SharedSessionRecord } from "./sharing.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
// In-flight requests: response with this id will be routed back to the
// requesting client only. Entries are cleared on response, client close, or
// after this TTL — bounds memory if a request never completes.
const PENDING_REQUEST_TTL_MS = 60_000;

export class RelayObject extends DurableObject<Env> {
  private daemonWs: WebSocket | null = null;
  private clientSockets = new Set<WebSocket>();
  private clientDeviceIds = new Map<WebSocket, string>();
  private pendingRequests = new Map<string, { client: WebSocket; clientRequestId: string; expiresAt: number }>();
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
    if (url.pathname === "/security/status" && request.method === "GET") {
      const state = await loadSecurityState(this.ctx.storage);
      return json({ ok: true, locked: isSecurityLockedDown(state), lockdown: state.lockdown }, 200);
    }
    if (url.pathname === "/security/push-token" && request.method === "POST") {
      if (await this.isLockedDown()) return json({ ok: false, error: "Remote access is locked" }, 423);
      return this.registerPushToken(request);
    }
    if (url.pathname === "/shares" && request.method === "GET") {
      return this.listShares(request);
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
    if (url.pathname === "/shares/invite" && request.method === "POST") {
      if (await this.isLockedDown()) return json({ ok: false, error: "Remote access is locked" }, 423);
      return this.createShareInvite(request);
    }
    if (url.pathname.startsWith("/shares/invite/") && url.pathname.endsWith("/accept")) {
      if (await this.isLockedDown()) return json({ ok: false, error: "Remote access is locked" }, 423);
      return this.acceptShareInvite(request, url);
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
    let sharedClientTags: string[] = [];
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
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(
      server,
      clientDevice ? [role, `device:${clientDevice.deviceId}`, ...sharedClientTags] : [role],
    );

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
      if (clientDevice) this.clientDeviceIds.set(server, clientDevice.deviceId);
      this.send(server, { type: "connected", role: "client" });
      this.send(server, { type: "daemon_status", online: this.daemonWs !== null });
      await this.recordClientConnected(request, server, clientDevice!);
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
        this.send(ws, {
          id: parsed.id,
          type: "response",
          status: 403,
          body: { ok: false, error: "Remote client pending security approval" },
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
      this.clientDeviceIds.delete(ws);
      for (const [id, entry] of this.pendingRequests) {
        if (entry.client === ws) this.pendingRequests.delete(id);
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

  private send(ws: WebSocket, msg: RelayMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private async recordClientConnected(
    request: Request,
    ws: WebSocket,
    device: ReturnType<typeof sanitizeDeviceInfo>,
  ): Promise<void> {
    const userId = request.headers.get("X-Aimux-User-Id") ?? "";
    const state = await loadSecurityState(this.ctx.storage);
    const ipHash = await hashIpAddress(request.headers.get("CF-Connecting-IP"), this.env.SECURITY_IP_HASH_SECRET);
    const context = {
      ipHash,
      country: request.headers.get("CF-IPCountry") ?? undefined,
      userAgent: request.headers.get("User-Agent") ?? undefined,
    };
    const result = recordClientConnection(state, device, context);
    let emergencyUrl: string | undefined;
    if (result.firstSeen && userId) {
      const action = await createSecurityActionToken("emergency_lockdown", { deviceId: result.device.id });
      result.state.actions[action.action.id] = action.action;
      emergencyUrl = `${this.securityActionBaseUrl(request)}/security/action/${encodeURIComponent(userId)}/${encodeURIComponent(action.token)}`;
    }
    await saveSecurityState(this.ctx.storage, result.state);
    for (const event of result.events) {
      if (this.daemonWs) {
        try {
          this.send(this.daemonWs, { type: "security_event", event });
        } catch {}
      }
      if (event.kind === "new_client_detected") {
        this.broadcastToClients({ type: "security_event", event }, ws);
        await deliverSecurityAlert({
          env: this.env,
          userId,
          event,
          device: result.device,
          pushTokens: Object.values(result.state.pushTokens),
          emergencyUrl,
        });
      }
    }
  }

  private async registerPushToken(request: Request): Promise<Response> {
    let body: { deviceId?: string; token?: string; platform?: "ios" | "android" | "web" | "unknown" };
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
    const state = await loadSecurityState(this.ctx.storage);
    state.pushTokens[deviceId] = {
      deviceId,
      token,
      platform: body.platform ?? "unknown",
      createdAt: state.pushTokens[deviceId]?.createdAt ?? now,
      updatedAt: now,
    };
    await saveSecurityState(this.ctx.storage, state);
    return json({ ok: true }, 200);
  }

  private async authorizeSharedClientConnect(
    request: Request,
    shareId: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
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
    return { ok: true, userId };
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
    const shares = Object.values(state.shares)
      .filter((share) => share.ownerUserId === userId || share.participants[userId]?.status === "active")
      .map(summarizeShare);
    return json({ ok: true, shares }, 200);
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
    return json({ ok: true, share: summarizeShare(share) }, 200);
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
    const result = removeShareParticipant(state, share.id, parsed.participantUserId);
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

  private async isLockedDown(): Promise<boolean> {
    const state = await loadSecurityState(this.ctx.storage);
    return isSecurityLockedDown(state);
  }

  private async shouldRejectClientRequest(ws: WebSocket): Promise<boolean> {
    if (this.env.SECURITY_DEVICE_POLICY !== "enforce") return false;
    const deviceId = this.clientDeviceIds.get(ws) ?? this.deviceIdFromTags(ws);
    if (!deviceId) return true;
    const state = await loadSecurityState(this.ctx.storage);
    return !isDeviceApproved(state.devices[deviceId]);
  }

  private ensureHeartbeat(): void {
    this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  private rehydrateSockets(exclude?: WebSocket): void {
    this.daemonWs = null;
    this.clientSockets.clear();
    this.clientDeviceIds.clear();
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

  private closeAllSockets(reason: string): void {
    this.failPendingRequests(reason, 423);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1008, reason);
      } catch {}
    }
    this.daemonWs = null;
    this.clientSockets.clear();
    this.clientDeviceIds.clear();
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

function canReadShare(share: SharedSessionRecord, userId: string): boolean {
  return share.ownerUserId === userId || share.participants[userId]?.status === "active";
}

function securityActionCss(): string {
  return "body{margin:0;background:#09090b;color:#fafafa;font-family:system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:520px;margin:18vh auto;padding:0 24px;line-height:1.5}h1{font-size:28px;margin:0 0 12px}p{color:#c4c4c7}button{border:0;border-radius:8px;background:#dc2626;color:white;font-weight:700;font-size:15px;padding:12px 16px;cursor:pointer}";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
