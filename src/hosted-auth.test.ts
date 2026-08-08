import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authenticateHosted, bearerToken, stripTrustedHeaders } from "./hosted-auth.js";
import { createHostedPrincipal, revokeHostedPrincipal } from "./hosted-principals.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";

beforeEach(() => {
  previousAimuxHome = process.env.AIMUX_HOME;
  aimuxHome = mkdtempSync(join(tmpdir(), "aimux-hosted-auth-"));
  process.env.AIMUX_HOME = aimuxHome;
});

afterEach(() => {
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  rmSync(aimuxHome, { recursive: true, force: true });
});

describe("stripTrustedHeaders", () => {
  it("removes every x-aimux-* header regardless of case", () => {
    const clean = stripTrustedHeaders({
      "x-aimux-actor-role": "owner",
      "X-Aimux-Actor-User-Id": "u1",
      "x-AIMUX-share-session-id": "s1",
      "x-aimux-anything-invented-later": "v",
      "content-type": "application/json",
      authorization: "Bearer amx_token",
    });

    expect(Object.keys(clean).sort()).toEqual(["authorization", "content-type"]);
  });

  it("normalizes casing and joins repeated headers", () => {
    const clean = stripTrustedHeaders({ "Content-Type": "application/json", accept: ["a", "b"], missing: undefined });
    expect(clean["content-type"]).toBe("application/json");
    expect(clean.accept).toBe("a, b");
    expect("missing" in clean).toBe(false);
  });
});

describe("bearerToken", () => {
  it("parses a bearer header in any case, with padding", () => {
    expect(bearerToken({ authorization: "Bearer amx_abc" })).toBe("amx_abc");
    expect(bearerToken({ authorization: "bearer   amx_abc  " })).toBe("amx_abc");
    expect(bearerToken({ Authorization: "BEARER amx_abc" })).toBe("amx_abc");
  });

  it("returns null for anything else", () => {
    expect(bearerToken({})).toBeNull();
    expect(bearerToken({ authorization: "Basic abc" })).toBeNull();
    expect(bearerToken({ authorization: "Bearer" })).toBeNull();
    expect(bearerToken({ authorization: "Bearer    " })).toBeNull();
  });
});

describe("authenticateHosted", () => {
  it("mints an operator actor for a live token", () => {
    const { principal, token } = createHostedPrincipal({ label: "grand" });
    const result = authenticateHosted({ authorization: `Bearer ${token}` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor.role).toBe("operator");
    expect(result.actor.principal?.id).toBe(principal.id);
  });

  it("refuses a missing, unknown, or revoked token", () => {
    const { principal, token } = createHostedPrincipal({ label: "grand" });

    expect(authenticateHosted({})).toEqual({ ok: false, reason: "missing_token" });
    expect(authenticateHosted({ authorization: "Bearer amx_nope" })).toEqual({ ok: false, reason: "unknown_token" });

    revokeHostedPrincipal(principal.id);
    expect(authenticateHosted({ authorization: `Bearer ${token}` })).toEqual({ ok: false, reason: "unknown_token" });
  });

  it("cannot be satisfied by a forged actor header", () => {
    // The header path is what the relay uses; hosted mode must not honour it.
    const forged = { "x-aimux-actor-role": "owner", "x-aimux-actor-user-id": "attacker" };
    expect(authenticateHosted(stripTrustedHeaders(forged))).toEqual({ ok: false, reason: "missing_token" });
  });
});
