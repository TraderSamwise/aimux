import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  countActiveHostedPrincipals,
  createHostedPrincipal,
  findPrincipalByToken,
  grantHostedSession,
  hashHostedToken,
  listHostedPrincipals,
  loadHostedPrincipals,
  markPrincipalSeen,
  principalHasGrant,
  revokeHostedPrincipal,
  ungrantHostedSession,
} from "./hosted-principals.js";
import { getHostedDir, getHostedPrincipalsPath } from "./paths.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";

beforeEach(() => {
  previousAimuxHome = process.env.AIMUX_HOME;
  aimuxHome = mkdtempSync(join(tmpdir(), "aimux-hosted-principals-"));
  process.env.AIMUX_HOME = aimuxHome;
});

afterEach(() => {
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  rmSync(aimuxHome, { recursive: true, force: true });
});

describe("hosted principal store", () => {
  it("starts empty when nothing is persisted", () => {
    expect(loadHostedPrincipals()).toEqual({ version: 1, principals: [] });
  });

  it("returns the token once and persists only its hash", () => {
    const { principal, token } = createHostedPrincipal({ label: "grand:admin:user_1" });

    expect(token.startsWith("amx_")).toBe(true);
    expect(principal.tokenHash).toBe(hashHostedToken(token));
    expect(principal.tokenHash.startsWith("sha256:")).toBe(true);

    const raw = readFileSync(getHostedPrincipalsPath(), "utf-8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(principal.tokenHash);
  });

  it("writes the store 0600 inside a 0700 directory", () => {
    createHostedPrincipal({ label: "a" });
    expect(statSync(getHostedPrincipalsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(getHostedDir()).mode & 0o777).toBe(0o700);
  });

  it("resolves a live token and rejects an unknown one", () => {
    const { principal, token } = createHostedPrincipal({ label: "a" });
    expect(findPrincipalByToken(token)?.id).toBe(principal.id);
    expect(findPrincipalByToken("amx_nope")).toBeNull();
    expect(findPrincipalByToken("")).toBeNull();
    expect(findPrincipalByToken("   ")).toBeNull();
  });

  it("stops resolving a revoked token", () => {
    const { principal, token } = createHostedPrincipal({ label: "a" });
    expect(revokeHostedPrincipal(principal.id)).toBe(true);
    expect(findPrincipalByToken(token)).toBeNull();
    expect(revokeHostedPrincipal(principal.id)).toBe(false);
    expect(revokeHostedPrincipal("prn_missing")).toBe(false);
  });

  it("keeps grants scoped to one project and session", () => {
    const { principal } = createHostedPrincipal({ label: "a" });
    expect(grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" })).toBe(true);

    const stored = listHostedPrincipals()[0]!;
    expect(principalHasGrant(stored, { projectRoot: "/srv/grand", sessionId: "assistant" })).toBe(true);
    // Same session id, different project — must not match.
    expect(principalHasGrant(stored, { projectRoot: "/srv/other", sessionId: "assistant" })).toBe(false);
    // Same project, different session — must not match.
    expect(principalHasGrant(stored, { projectRoot: "/srv/grand", sessionId: "other" })).toBe(false);
  });

  it("normalizes project roots so a trailing slash still matches", () => {
    const { principal } = createHostedPrincipal({ label: "a" });
    grantHostedSession(principal.id, { projectRoot: "/srv/grand/", sessionId: "assistant" });
    const stored = listHostedPrincipals()[0]!;
    expect(principalHasGrant(stored, { projectRoot: "/srv/grand", sessionId: "assistant" })).toBe(true);
  });

  it("never authorizes a revoked principal even with a matching grant", () => {
    const { principal } = createHostedPrincipal({ label: "a" });
    grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
    revokeHostedPrincipal(principal.id);
    const stored = listHostedPrincipals()[0]!;
    expect(principalHasGrant(stored, { projectRoot: "/srv/grand", sessionId: "assistant" })).toBe(false);
  });

  it("does not duplicate an identical grant, and refuses partial ones", () => {
    const { principal } = createHostedPrincipal({ label: "a" });
    grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
    grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
    expect(listHostedPrincipals()[0]!.grants).toHaveLength(1);

    expect(grantHostedSession(principal.id, { projectRoot: "", sessionId: "assistant" })).toBe(false);
    expect(grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "" })).toBe(false);
  });

  it("refuses to grant to a revoked principal", () => {
    const { principal } = createHostedPrincipal({ label: "a" });
    revokeHostedPrincipal(principal.id);
    expect(grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" })).toBe(false);
  });

  it("ungrants only the named session", () => {
    const { principal } = createHostedPrincipal({ label: "a" });
    grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "one" });
    grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "two" });

    expect(ungrantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "one" })).toBe(true);
    expect(ungrantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "one" })).toBe(false);
    expect(listHostedPrincipals()[0]!.grants).toEqual([{ projectRoot: "/srv/grand", sessionId: "two" }]);
  });

  it("keeps principals separate", () => {
    const first = createHostedPrincipal({ label: "first" });
    const second = createHostedPrincipal({ label: "second" });
    grantHostedSession(first.principal.id, { projectRoot: "/srv/grand", sessionId: "one" });

    const resolved = findPrincipalByToken(second.token)!;
    expect(resolved.id).toBe(second.principal.id);
    expect(principalHasGrant(resolved, { projectRoot: "/srv/grand", sessionId: "one" })).toBe(false);
    expect(listHostedPrincipals()).toHaveLength(2);
  });

  it("records last-seen without disturbing other fields", () => {
    const { principal, token } = createHostedPrincipal({ label: "a" });
    markPrincipalSeen(principal.id);
    const resolved = findPrincipalByToken(token)!;
    expect(resolved.lastSeenAt).not.toBeNull();
    expect(resolved.label).toBe("a");

    // Throttled: this runs on authenticated requests and must not rewrite the
    // store (or take its lock) every time.
    const first = resolved.lastSeenAt;
    markPrincipalSeen(principal.id);
    expect(findPrincipalByToken(token)!.lastSeenAt).toBe(first);
    markPrincipalSeen("prn_missing");
  });

  it("counts only active principals", () => {
    expect(countActiveHostedPrincipals()).toBe(0);
    const first = createHostedPrincipal({ label: "a" });
    createHostedPrincipal({ label: "b" });
    expect(countActiveHostedPrincipals()).toBe(2);
    revokeHostedPrincipal(first.principal.id);
    expect(countActiveHostedPrincipals()).toBe(1);
  });

  it("refuses a relative project root on the check side", () => {
    const { principal } = createHostedPrincipal({ label: "a" });
    grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
    const stored = listHostedPrincipals()[0]!;
    // Would otherwise resolve against the daemon's cwd and could widen the grant.
    expect(principalHasGrant(stored, { projectRoot: "srv/grand", sessionId: "assistant" })).toBe(false);
    expect(principalHasGrant(stored, { projectRoot: "", sessionId: "assistant" })).toBe(false);
  });

  it("releases the store lock after each mutation", () => {
    const { principal } = createHostedPrincipal({ label: "a" });
    grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
    expect(existsSync(`${getHostedPrincipalsPath()}.lock`)).toBe(false);
  });

  it("steals a stale lock rather than deadlocking", () => {
    const lock = `${getHostedPrincipalsPath()}.lock`;
    mkdirSync(getHostedDir(), { recursive: true });
    writeFileSync(lock, "999999.deadbeef");
    // Older than LOCK_STALE_MS — the holder is gone and never released it.
    const ancient = new Date(Date.now() - 120_000);
    utimesSync(lock, ancient, ancient);

    const { principal } = createHostedPrincipal({ label: "a" });
    expect(listHostedPrincipals().map((p) => p.id)).toEqual([principal.id]);
    expect(existsSync(lock)).toBe(false);
  });

  it("refuses to persist over a store it could not read", () => {
    createHostedPrincipal({ label: "a" });
    const path = getHostedPrincipalsPath();
    chmodSync(path, 0o000);
    try {
      // An I/O failure must surface, not quietly quarantine a good store and
      // then let the next write persist an empty one over it.
      expect(() => loadHostedPrincipals()).toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
    expect(listHostedPrincipals()).toHaveLength(1);
  });

  it("drops malformed entries and survives a corrupt store", () => {
    mkdirSync(getHostedDir(), { recursive: true });
    writeFileSync(
      getHostedPrincipalsPath(),
      JSON.stringify({
        version: 1,
        principals: [
          { id: "prn_ok", tokenHash: "sha256:abcd", label: "ok", grants: [{ projectRoot: "/p", sessionId: "s" }] },
          { id: "prn_nohash" },
          { tokenHash: "sha256:abcd" },
          { id: "prn_badhash", tokenHash: "plaintext" },
          "garbage",
        ],
      }),
    );
    expect(loadHostedPrincipals().principals.map((p) => p.id)).toEqual(["prn_ok"]);

    writeFileSync(getHostedPrincipalsPath(), "{ not json");
    expect(loadHostedPrincipals()).toEqual({ version: 1, principals: [] });
    expect(readdirSync(getHostedDir()).some((name) => name.includes("corrupt"))).toBe(true);
  });

  it("does not match a stored hash of the wrong length", () => {
    mkdirSync(getHostedDir(), { recursive: true });
    writeFileSync(
      getHostedPrincipalsPath(),
      JSON.stringify({ version: 1, principals: [{ id: "prn_short", tokenHash: "sha256:ab", label: "s", grants: [] }] }),
    );
    expect(findPrincipalByToken("anything")).toBeNull();
  });
});
