import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { atomicWrite, quarantineCorruptFile } from "./atomic-write.js";
import { getHostedDir, getHostedPrincipalsPath } from "./paths.js";

/**
 * Hosted-mode principals: who may connect, and to exactly which sessions.
 *
 * Tokens are opaque bearer credentials shown once at creation and stored only
 * as a hash. A grant names both project root and session id because session ids
 * are project-scoped, not globally unique — matching on the id alone would let
 * a grant for "main" in one project authorize "main" in another.
 */

export type HostedRole = "operator";

export interface HostedGrant {
  projectRoot: string;
  sessionId: string;
}

export interface HostedPrincipal {
  id: string;
  label: string;
  tokenHash: string;
  role: HostedRole;
  grants: HostedGrant[];
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export interface HostedPrincipalsState {
  version: 1;
  principals: HostedPrincipal[];
}

const TOKEN_PREFIX = "amx_";
const HASH_PREFIX = "sha256:";
const TOKEN_BYTES = 32;

export function hashHostedToken(token: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function emptyState(): HostedPrincipalsState {
  return { version: 1, principals: [] };
}

function normalizeGrant(raw: unknown): HostedGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const projectRoot = typeof value.projectRoot === "string" ? value.projectRoot.trim() : "";
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  // Absolute only, on both the store and the check side: a relative root would
  // resolve against whatever cwd the process happens to have, so the same grant
  // would mean different things to the CLI and the daemon.
  if (!projectRoot || !sessionId || !isAbsolute(projectRoot)) return null;
  return { projectRoot: resolve(projectRoot), sessionId };
}

function normalizePrincipal(raw: unknown): HostedPrincipal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const tokenHash = typeof value.tokenHash === "string" ? value.tokenHash.trim() : "";
  if (!id || !tokenHash.startsWith(HASH_PREFIX)) return null;

  const grants = Array.isArray(value.grants)
    ? value.grants.map(normalizeGrant).filter((grant): grant is HostedGrant => grant !== null)
    : [];

  return {
    id,
    label: typeof value.label === "string" ? value.label : id,
    tokenHash,
    role: "operator",
    grants,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : null,
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : null,
  };
}

export function loadHostedPrincipals(): HostedPrincipalsState {
  const path = getHostedPrincipalsPath();
  if (!existsSync(path)) return emptyState();

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    // Only malformed CONTENT is quarantinable. Swallowing an I/O error here
    // would quarantine a perfectly good store and let `mutate` persist an empty
    // one over it — losing every principal and grant.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const principals = Array.isArray(parsed?.principals)
      ? parsed.principals.map(normalizePrincipal).filter((p): p is HostedPrincipal => p !== null)
      : [];
    return { version: 1, principals };
  } catch {
    quarantineCorruptFile(path);
    return emptyState();
  }
}

function saveHostedPrincipals(state: HostedPrincipalsState): void {
  // 0700/0600: this file is the sole authority on who may drive a session.
  mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
  atomicWrite(getHostedPrincipalsPath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function lockPath(): string {
  return `${getHostedPrincipalsPath()}.lock`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(): { fd: number; token: string } {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const fd = openSync(lockPath(), "wx", 0o600);
      // Ownership stamp: a stale-lock stealer must not delete a lock that some
      // other process has since legitimately taken.
      const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
      writeSync(fd, token);
      return { fd, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath()).mtimeMs > LOCK_STALE_MS) rmSync(lockPath(), { force: true });
      } catch {
        // The holder released it between our open and stat; just retry.
      }
      if (Date.now() > deadline) throw new Error("hosted principal store is locked", { cause: error });
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

/**
 * Read-modify-write under an exclusive lock.
 *
 * Without the lock a concurrent `markPrincipalSeen` could load state, have a
 * revoke land underneath it, then write its stale copy back — silently
 * un-revoking a token. That is an authentication bypass, not a lost write.
 */
function mutate<T>(fn: (state: HostedPrincipalsState) => T): T {
  const { fd, token } = acquireLock();
  try {
    const state = loadHostedPrincipals();
    const result = fn(state);
    saveHostedPrincipals(state);
    return result;
  } finally {
    closeSync(fd);
    try {
      if (readFileSync(lockPath(), "utf-8") === token) rmSync(lockPath(), { force: true });
    } catch {
      // Already gone, or now someone else's — either way not ours to remove.
    }
  }
}

export function listHostedPrincipals(): HostedPrincipal[] {
  return loadHostedPrincipals().principals;
}

export function createHostedPrincipal(input: { label: string }): { principal: HostedPrincipal; token: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  const principal: HostedPrincipal = {
    id: `prn_${randomBytes(6).toString("hex")}`,
    label: input.label.trim() || "unlabelled",
    tokenHash: hashHostedToken(token),
    role: "operator",
    grants: [],
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastSeenAt: null,
  };
  mutate((state) => state.principals.push(principal));
  return { principal, token };
}

export function revokeHostedPrincipal(id: string): boolean {
  return mutate((state) => {
    const principal = state.principals.find((entry) => entry.id === id);
    if (!principal || principal.revokedAt) return false;
    principal.revokedAt = new Date().toISOString();
    return true;
  });
}

export function grantHostedSession(id: string, grant: HostedGrant): boolean {
  const normalized = normalizeGrant(grant);
  if (!normalized) return false;
  return mutate((state) => {
    const principal = state.principals.find((entry) => entry.id === id && !entry.revokedAt);
    if (!principal) return false;
    const exists = principal.grants.some(
      (entry) => entry.projectRoot === normalized.projectRoot && entry.sessionId === normalized.sessionId,
    );
    if (!exists) principal.grants.push(normalized);
    return true;
  });
}

export function ungrantHostedSession(id: string, grant: HostedGrant): boolean {
  const normalized = normalizeGrant(grant);
  if (!normalized) return false;
  return mutate((state) => {
    const principal = state.principals.find((entry) => entry.id === id);
    if (!principal) return false;
    const before = principal.grants.length;
    principal.grants = principal.grants.filter(
      (entry) => !(entry.projectRoot === normalized.projectRoot && entry.sessionId === normalized.sessionId),
    );
    return principal.grants.length !== before;
  });
}

function hashesMatch(a: string, b: string): boolean {
  if (!a.startsWith(HASH_PREFIX) || !b.startsWith(HASH_PREFIX)) return false;
  const left = Buffer.from(a.slice(HASH_PREFIX.length), "hex");
  const right = Buffer.from(b.slice(HASH_PREFIX.length), "hex");
  // timingSafeEqual throws on length mismatch, which a malformed stored hash can cause.
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Resolve a bearer token to a live principal. Revoked principals never match. */
export function findPrincipalByToken(token: string): HostedPrincipal | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const candidate = hashHostedToken(trimmed);
  for (const principal of loadHostedPrincipals().principals) {
    if (principal.revokedAt) continue;
    if (hashesMatch(principal.tokenHash, candidate)) return principal;
  }
  return null;
}

/** Live principals only — a revoked one must not hold a listener open. */
export function countActiveHostedPrincipals(): number {
  return loadHostedPrincipals().principals.filter((principal) => !principal.revokedAt).length;
}

/** Both halves are required: session ids are unique only within a project. */
export function principalHasGrant(principal: HostedPrincipal, grant: HostedGrant): boolean {
  if (principal.revokedAt) return false;
  const normalized = normalizeGrant(grant);
  if (!normalized) return false;
  return principal.grants.some(
    (entry) => entry.projectRoot === normalized.projectRoot && entry.sessionId === normalized.sessionId,
  );
}

const SEEN_THROTTLE_MS = 60_000;

/**
 * Best-effort last-seen stamp. Throttled because this runs on authenticated
 * requests — an unthrottled version would take the store lock and rewrite the
 * file on every single call.
 */
export function markPrincipalSeen(id: string): void {
  const current = loadHostedPrincipals().principals.find((entry) => entry.id === id);
  if (!current) return;
  const last = current.lastSeenAt ? Date.parse(current.lastSeenAt) : Number.NaN;
  if (Number.isFinite(last) && Date.now() - last < SEEN_THROTTLE_MS) return;

  mutate((state) => {
    const principal = state.principals.find((entry) => entry.id === id);
    if (principal) principal.lastSeenAt = new Date().toISOString();
  });
}
