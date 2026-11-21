import { describe, expect, it } from "vitest";

import { canClaimSwarmHost, swarmHostView } from "@/lib/swarm-host-view";

describe("the swarm host panel's view", () => {
  // The route sends a null host for the machine holding the pin, so this case
  // alone does NOT prove the read order -- the case below does. Said here
  // because the first version of this comment claimed it did.
  it("says the pin is here when this machine holds it", () => {
    expect(swarmHostView({ ok: true, host: null, thisMachine: true })).toEqual({ kind: "here" });
  });

  // The gate that makes the ordering real. My first version claimed the order
  // mattered and no case exercised it: every fixture gave the holder a null
  // host, so reading `host` first fell through to `thisMachine` anyway and the
  // mutation passed. A report carrying BOTH is "here" -- the one thing it
  // certainly is not is elsewhere.
  it("is here when the report names the host and says it is this machine", () => {
    expect(swarmHostView({ ok: true, host: "mbp", thisMachine: true })).toEqual({ kind: "here" });
  });

  it("names the machine when another one holds it", () => {
    expect(swarmHostView({ ok: true, host: "mini", thisMachine: false })).toEqual({
      kind: "elsewhere",
      host: "mini",
    });
  });

  it("is unclaimed when nobody holds it", () => {
    expect(swarmHostView({ ok: true, host: null, thisMachine: false })).toEqual({
      kind: "unclaimed",
    });
  });

  // The distinction the view exists for. An unreadable pin may already name a
  // machine, so telling somebody nobody holds it invites the second swarm
  // overseer the daemon refuses to start.
  it("keeps an unreadable pin apart from an unclaimed one", () => {
    const view = swarmHostView({
      ok: false,
      error: 'swarm.host is "Not A Machine", which is not a machine id',
    });
    expect(view).toEqual({
      kind: "unreadable",
      reason: 'swarm.host is "Not A Machine", which is not a machine id',
    });
    expect(view.kind).not.toBe("unclaimed");
  });

  it("falls back to its own words when an unreadable pin carries no reason", () => {
    const view = swarmHostView({ ok: false });
    expect(view.kind).toBe("unreadable");
    if (view.kind === "unreadable") expect(view.reason).toContain("could not be read");
  });

  it("is loading before the first answer arrives", () => {
    expect(swarmHostView(null)).toEqual({ kind: "loading" });
  });

  describe("canClaimSwarmHost", () => {
    it("offers the claim only when nobody holds the pin", () => {
      expect(canClaimSwarmHost({ kind: "unclaimed" })).toBe(true);
    });

    // Offering a button the daemon is going to refuse is worse than not
    // offering it: `elsewhere` would be a second swarm overseer, and
    // `unreadable` might be one too.
    it("does not offer a claim that would be refused", () => {
      expect(canClaimSwarmHost({ kind: "here" })).toBe(false);
      expect(canClaimSwarmHost({ kind: "elsewhere", host: "mini" })).toBe(false);
      expect(canClaimSwarmHost({ kind: "unreadable", reason: "broken" })).toBe(false);
      expect(canClaimSwarmHost({ kind: "loading" })).toBe(false);
    });
  });
});
