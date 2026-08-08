import { findPrincipalByToken, type HostedPrincipal } from "./hosted-principals.js";
import type { RemoteActor } from "./remote-access.js";

/**
 * Authentication for the hosted listener.
 *
 * The daemon's other remote path — the relay — carries identity in `x-aimux-*`
 * headers, and trusts them because only the relay's Durable Object can set
 * them. Hosted mode has no such guarantee: anything that can reach the port can
 * send any header it likes. So identity here comes from a bearer token, and
 * every inbound trusted header is destroyed before a single line of code looks
 * at the request.
 */

const TRUSTED_HEADER_PREFIX = "x-aimux-";

export type HostedAuthFailure = "missing_token" | "unknown_token";

export type HostedAuthResult =
  | { ok: true; actor: RemoteActor; principal: HostedPrincipal }
  | { ok: false; reason: HostedAuthFailure };

/**
 * Drop every header the daemon would otherwise treat as proof of identity.
 *
 * Runs before authentication, not after, so there is no window in which a
 * forged `x-aimux-actor-role: owner` is visible to anything downstream.
 */
export function stripTrustedHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().startsWith(TRUSTED_HEADER_PREFIX)) continue;
    if (value === undefined) continue;
    clean[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return clean;
}

export function bearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * Resolve a request to an operator, or refuse it.
 *
 * The actor is built here and handed to the daemon out-of-band. It is never
 * serialized into a header, because a header is exactly what an attacker can
 * write.
 */
export function authenticateHosted(headers: Record<string, string | string[] | undefined>): HostedAuthResult {
  const token = bearerToken(headers);
  if (!token) return { ok: false, reason: "missing_token" };

  const principal = findPrincipalByToken(token);
  if (!principal) return { ok: false, reason: "unknown_token" };

  return { ok: true, principal, actor: { role: "operator", principal } };
}
