// Long-lived daemon tokens, signed by the relay itself (HS256).
//
// Clerk session JWTs expire in ~60s — unusable for a long-running daemon.
// After a user authenticates via the browser (`aimux login`), the relay mints
// one of these tokens tied to their Clerk userId. The daemon stores it and
// presents it on /daemon/connect. The relay verifies it with the same secret.

const DAEMON_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function base64UrlEncode(data: ArrayBuffer | string): string {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(input: string): string {
  let padded = input.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4) padded += "=";
  return atob(padded);
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface DaemonTokenPayload {
  sub: string; // Clerk userId
  type: "daemon";
  iat: number;
  exp: number;
}

export async function mintDaemonToken(userId: string, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: DaemonTokenPayload = {
    sub: userId,
    type: "daemon",
    iat: now,
    exp: now + DAEMON_TOKEN_TTL_SECONDS,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const sigB64 = base64UrlEncode(signature);

  return `${signingInput}.${sigB64}`;
}

export async function verifyDaemonToken(token: string, secret: string): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const expectedSig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  const expectedSigB64 = base64UrlEncode(expectedSig);

  // Constant-time-ish comparison via length + char check.
  if (sigB64.length !== expectedSigB64.length) throw new Error("Bad signature");
  let mismatch = 0;
  for (let i = 0; i < sigB64.length; i++) {
    mismatch |= sigB64.charCodeAt(i) ^ expectedSigB64.charCodeAt(i);
  }
  if (mismatch !== 0) throw new Error("Bad signature");

  const payload = JSON.parse(base64UrlDecodeToString(payloadB64)) as DaemonTokenPayload;
  if (payload.type !== "daemon") throw new Error("Wrong token type");
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
  return payload.sub;
}

export function isDaemonToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(base64UrlDecodeToString(parts[1])) as { type?: string };
    return payload.type === "daemon";
  } catch {
    return false;
  }
}
