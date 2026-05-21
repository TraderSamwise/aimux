import { verifyWsToken } from "./auth.js";
import { isDaemonToken, mintDaemonToken, verifyDaemonToken } from "./daemon-token.js";
import type { Env } from "./types.js";

export { RelayObject } from "./relay-object.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health") {
      return corsResponse(JSON.stringify({ ok: true }), 200);
    }

    // Mint a long-lived daemon token. The caller authenticates with a Clerk
    // session JWT (Authorization: Bearer) obtained in the browser. Used by the
    // web app's /cli-auth page during `aimux login`.
    if (url.pathname === "/cli/issue-token" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      const clerkToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!clerkToken) {
        return corsResponse(JSON.stringify({ ok: false, error: "Missing authorization" }), 401);
      }
      let userId: string;
      try {
        userId = await verifyWsToken(clerkToken, env);
      } catch {
        return corsResponse(JSON.stringify({ ok: false, error: "Invalid token" }), 401);
      }
      if (!env.RELAY_TOKEN_SECRET) {
        return corsResponse(JSON.stringify({ ok: false, error: "Relay not configured" }), 500);
      }
      const daemonToken = await mintDaemonToken(userId, env.RELAY_TOKEN_SECRET);
      return corsResponse(JSON.stringify({ ok: true, token: daemonToken }), 200);
    }

    if (url.pathname !== "/daemon/connect" && url.pathname !== "/client/connect") {
      return corsResponse(JSON.stringify({ ok: false, error: "Not found" }), 404);
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return corsResponse(JSON.stringify({ ok: false, error: "Expected WebSocket upgrade" }), 426);
    }

    const token = url.searchParams.get("token");
    if (!token) {
      return corsResponse(JSON.stringify({ ok: false, error: "Missing token parameter" }), 401);
    }

    // Daemons present a relay-signed long-lived token; web clients present a
    // short-lived Clerk session JWT. Pick the verifier by token shape.
    let userId: string;
    try {
      if (isDaemonToken(token)) {
        userId = await verifyDaemonToken(token, env.RELAY_TOKEN_SECRET);
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

    return stub.fetch(new Request(doUrl.toString(), request));
  },
};
