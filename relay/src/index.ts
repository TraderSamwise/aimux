import { fetchClerkUserProfile, verifyWsToken } from "./auth.js";
import { isDaemonToken, mintDaemonToken, verifyDaemonTokenPayload } from "./daemon-token.js";
import type { Env } from "./types.js";

export { RelayObject } from "./relay-object.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const TOKEN_PROTOCOL_PREFIX = "aimux-token.";

function corsResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// Restricted CORS for token issuance — echoes back the request Origin only
// if it matches the CLI_TOKEN_ALLOWED_ORIGINS allowlist, never the wildcard.
function tokenIssueCorsHeaders(request: Request, env: Env): Record<string, string> | null {
  const allowed = (env.CLI_TOKEN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return null;
  const origin = request.headers.get("Origin") ?? "";
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function tokenIssueResponse(body: string, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getWebSocketToken(request: Request): string | null {
  const protocols = request.headers.get("Sec-WebSocket-Protocol") ?? "";
  for (const rawProtocol of protocols.split(",")) {
    const protocol = rawProtocol.trim();
    if (protocol.startsWith(TOKEN_PROTOCOL_PREFIX)) {
      return protocol.slice(TOKEN_PROTOCOL_PREFIX.length);
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      // For the token-issuing endpoint, gate the preflight by origin too.
      if (url.pathname === "/cli/issue-token") {
        const headers = tokenIssueCorsHeaders(request, env);
        if (!headers) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers });
      }
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health") {
      return corsResponse(JSON.stringify({ ok: true }), 200);
    }

    if (url.pathname.startsWith("/security/action/")) {
      const [, , , userId] = url.pathname.split("/");
      if (!userId) return corsResponse(JSON.stringify({ ok: false, error: "Invalid security action URL" }), 400);
      const relayId = env.RELAY.idFromName(decodeURIComponent(userId));
      const stub = env.RELAY.get(relayId);
      return stub.fetch(request);
    }

    if (url.pathname === "/security/push-token" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      const clerkToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!clerkToken) {
        return corsResponse(JSON.stringify({ ok: false, error: "Missing authorization" }), 401);
      }
      if (!env.CLERK_SECRET_KEY) {
        return corsResponse(JSON.stringify({ ok: false, error: "Relay not configured: CLERK_SECRET_KEY unset" }), 500);
      }
      let userId: string;
      try {
        userId = await verifyWsToken(clerkToken, env);
      } catch {
        return corsResponse(JSON.stringify({ ok: false, error: "Invalid token" }), 401);
      }
      const relayId = env.RELAY.idFromName(userId);
      const stub = env.RELAY.get(relayId);
      const headers = new Headers(request.headers);
      headers.set("X-Aimux-User-Id", userId);
      return stub.fetch(new Request(request, { headers }));
    }

    if (url.pathname === "/shares" || url.pathname === "/shares/invite" || url.pathname.startsWith("/shares/invite/")) {
      const authHeader = request.headers.get("Authorization");
      const clerkToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!clerkToken) {
        return corsResponse(JSON.stringify({ ok: false, error: "Missing authorization" }), 401);
      }
      if (!env.CLERK_SECRET_KEY) {
        return corsResponse(JSON.stringify({ ok: false, error: "Relay not configured: CLERK_SECRET_KEY unset" }), 500);
      }
      let userId: string;
      try {
        userId = await verifyWsToken(clerkToken, env);
      } catch {
        return corsResponse(JSON.stringify({ ok: false, error: "Invalid token" }), 401);
      }
      const profile = await fetchClerkUserProfile(env, userId);
      const inviteAcceptMatch = url.pathname.match(/^\/shares\/invite\/([^/]+)\/([^/]+)\/accept$/);
      const ownerUserId = inviteAcceptMatch ? decodeURIComponent(inviteAcceptMatch[1]) : userId;
      const relayId = env.RELAY.idFromName(ownerUserId);
      const stub = env.RELAY.get(relayId);
      const headers = new Headers(request.headers);
      headers.set("X-Aimux-User-Id", userId);
      headers.set("X-Aimux-User-Name", profile.displayName);
      if (profile.email) headers.set("X-Aimux-User-Email", profile.email);
      if (inviteAcceptMatch) headers.set("X-Aimux-Share-Owner-Id", ownerUserId);
      return stub.fetch(new Request(request, { headers }));
    }

    // Mint a long-lived daemon token. The caller authenticates with a Clerk
    // session JWT (Authorization: Bearer) obtained in the browser. Used by the
    // web app's /cli-auth page during `aimux login`.
    if (url.pathname === "/cli/issue-token" && request.method === "POST") {
      // CORS is intentionally restrictive on this endpoint — minting daemon
      // tokens for arbitrary origins would let any site holding a Clerk JWT
      // exfiltrate them.
      const corsHeaders = tokenIssueCorsHeaders(request, env);
      if (!corsHeaders) {
        return new Response(JSON.stringify({ ok: false, error: "Origin not allowed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      const authHeader = request.headers.get("Authorization");
      const clerkToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!clerkToken) {
        return tokenIssueResponse(JSON.stringify({ ok: false, error: "Missing authorization" }), 401, corsHeaders);
      }
      // Distinguish unset Clerk secret (server misconfig → 500) from a bad
      // token (auth failure → 401) so deployments fail loudly when secrets
      // are missing.
      if (!env.CLERK_SECRET_KEY) {
        return tokenIssueResponse(
          JSON.stringify({ ok: false, error: "Relay not configured: CLERK_SECRET_KEY unset" }),
          500,
          corsHeaders,
        );
      }
      if (!env.RELAY_TOKEN_SECRET) {
        return tokenIssueResponse(
          JSON.stringify({ ok: false, error: "Relay not configured: RELAY_TOKEN_SECRET unset" }),
          500,
          corsHeaders,
        );
      }
      let userId: string;
      try {
        userId = await verifyWsToken(clerkToken, env);
      } catch {
        return tokenIssueResponse(JSON.stringify({ ok: false, error: "Invalid token" }), 401, corsHeaders);
      }
      let body: { unlockSecurity?: boolean } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        // Older clients sent an empty body. Keep token issuance backward-compatible.
      }
      const relayId = env.RELAY.idFromName(userId);
      const stub = env.RELAY.get(relayId);
      if (body.unlockSecurity) {
        const res = await stub.fetch(new Request(new URL("/security/unlock", request.url), { method: "POST" }));
        if (!res.ok) {
          return tokenIssueResponse(
            JSON.stringify({ ok: false, error: "Could not unlock relay security state" }),
            502,
            corsHeaders,
          );
        }
      } else {
        const res = await stub.fetch(new Request(new URL("/security/status", request.url), { method: "GET" }));
        const status = res.ok ? ((await res.json()) as { locked?: boolean }) : {};
        if (status.locked) {
          return tokenIssueResponse(
            JSON.stringify({ ok: false, error: "Remote access is locked. Run `aimux security unlock`." }),
            423,
            corsHeaders,
          );
        }
      }
      const daemonToken = await mintDaemonToken(userId, env.RELAY_TOKEN_SECRET);
      return tokenIssueResponse(JSON.stringify({ ok: true, token: daemonToken }), 200, corsHeaders);
    }

    if (url.pathname !== "/daemon/connect" && url.pathname !== "/client/connect") {
      return corsResponse(JSON.stringify({ ok: false, error: "Not found" }), 404);
    }

    const upgradeHeader = request.headers.get("Upgrade")?.toLowerCase();
    if (upgradeHeader !== "websocket") {
      return corsResponse(JSON.stringify({ ok: false, error: "Expected WebSocket upgrade" }), 426);
    }

    const token = getWebSocketToken(request);
    if (!token) {
      return corsResponse(JSON.stringify({ ok: false, error: "Missing WebSocket token protocol" }), 401);
    }

    // Daemons present a relay-signed long-lived token; web clients present a
    // short-lived Clerk session JWT. Pick the verifier by token shape. Check
    // required secrets up front so a missing config returns 500 (server
    // misconfig) instead of being masked as 401 "Invalid token".
    const isDaemonEndpoint = url.pathname === "/daemon/connect";
    const tokenIsDaemon = isDaemonToken(token);
    if (isDaemonEndpoint !== tokenIsDaemon) {
      return corsResponse(JSON.stringify({ ok: false, error: "Token type does not match endpoint" }), 403);
    }

    if (tokenIsDaemon && !env.RELAY_TOKEN_SECRET) {
      return corsResponse(JSON.stringify({ ok: false, error: "Relay not configured: RELAY_TOKEN_SECRET unset" }), 500);
    }
    if (!tokenIsDaemon && !env.CLERK_SECRET_KEY) {
      return corsResponse(JSON.stringify({ ok: false, error: "Relay not configured: CLERK_SECRET_KEY unset" }), 500);
    }
    let userId: string;
    let daemonIssuedAt: number | undefined;
    try {
      if (tokenIsDaemon) {
        const payload = await verifyDaemonTokenPayload(token, env.RELAY_TOKEN_SECRET!);
        userId = payload.sub;
        daemonIssuedAt = payload.iat;
      } else {
        userId = await verifyWsToken(token, env);
      }
    } catch {
      return corsResponse(JSON.stringify({ ok: false, error: "Invalid token" }), 401);
    }

    const relayId = env.RELAY.idFromName(userId);
    const stub = env.RELAY.get(relayId);

    const doUrl = new URL(request.url);
    doUrl.searchParams.delete("token");

    const headers = new Headers(request.headers);
    headers.set("X-Aimux-User-Id", userId);
    if (daemonIssuedAt !== undefined) headers.set("X-Aimux-Daemon-Iat", String(daemonIssuedAt));
    return stub.fetch(new Request(doUrl.toString(), { headers }));
  },
};
