import { verifyWsToken } from "./auth.js";
import type { Env } from "./types.js";

export { RelayObject } from "./relay-object.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

    let userId: string;
    try {
      userId = await verifyWsToken(token, env);
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
