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
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function tokenIssueResponse(
  body: string,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
        return tokenIssueResponse(
          JSON.stringify({ ok: false, error: "Missing authorization" }),
          401,
          corsHeaders,
        );
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
        return tokenIssueResponse(
          JSON.stringify({ ok: false, error: "Invalid token" }),
          401,
          corsHeaders,
        );
      }
      const daemonToken = await mintDaemonToken(userId, env.RELAY_TOKEN_SECRET);
      return tokenIssueResponse(
        JSON.stringify({ ok: true, token: daemonToken }),
        200,
        corsHeaders,
      );
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
    // short-lived Clerk session JWT. Pick the verifier by token shape. Check
    // required secrets up front so a missing config returns 500 (server
    // misconfig) instead of being masked as 401 "Invalid token".
    if (isDaemonToken(token) && !env.RELAY_TOKEN_SECRET) {
      return corsResponse(
        JSON.stringify({ ok: false, error: "Relay not configured: RELAY_TOKEN_SECRET unset" }),
        500,
      );
    }
    if (!isDaemonToken(token) && !env.CLERK_SECRET_KEY) {
      return corsResponse(
        JSON.stringify({ ok: false, error: "Relay not configured: CLERK_SECRET_KEY unset" }),
        500,
      );
    }
    let userId: string;
    try {
      if (isDaemonToken(token)) {
        userId = await verifyDaemonToken(token, env.RELAY_TOKEN_SECRET!);
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
