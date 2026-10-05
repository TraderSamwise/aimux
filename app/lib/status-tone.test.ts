import { describe, expect, it } from "vitest";
import {
  TRANSIENT_ACTIONS,
  agentStatusKind,
  aggregateStatusKind,
  appStatusColors,
  serviceStatusKind,
} from "./status-tone";

describe("status-tone", () => {
  it("maps raw agent runtime status to TUI status semantics", () => {
    expect(agentStatusKind({ status: "running" })).toBe("working");
    expect(agentStatusKind({ status: "waiting" })).toBe("needs");
    expect(agentStatusKind({ status: "idle" })).toBe("idle");
    expect(agentStatusKind({ status: "offline" })).toBe("offline");
  });

  it("uses attention above raw running status", () => {
    expect(agentStatusKind({ status: "running", attention: "needs_input" })).toBe("needs");
    expect(agentStatusKind({ status: "running", attention: "blocked" })).toBe("blocked");
    expect(agentStatusKind({ activity: "waiting", attention: "waiting_on_peers" })).toBe("idle");
    expect(agentStatusKind({ status: "running", attention: "error" })).toBe("error");
  });

  it("treats offline as offline before stale attention or activity", () => {
    expect(agentStatusKind({ status: "offline", attention: "needs_input" })).toBe("offline");
    expect(agentStatusKind({ status: "offline", activity: "done" })).toBe("offline");
    expect(agentStatusKind({ status: "exited", attention: "error" })).toBe("offline");
  });

  it("keeps services on service-specific semantics", () => {
    expect(serviceStatusKind({ status: "running" })).toBe("service");
    expect(serviceStatusKind({ status: "offline" })).toBe("serviceOff");
  });

  it("aggregates by status urgency for worktree accents", () => {
    expect(aggregateStatusKind(["working", "needs", "offline"])).toBe("needs");
    expect(aggregateStatusKind(["done", "offline"])).toBe("done");
    expect(aggregateStatusKind(["serviceOff", "offline"])).toBe("serviceOff");
  });

  it("exposes inline colors for native status glyphs", () => {
    expect(appStatusColors("needs")).toEqual({
      background: "rgba(215, 175, 95, 0.12)",
      border: "rgba(215, 175, 95, 0.35)",
      foreground: "#d7af5f",
    });
    expect(appStatusColors("running").foreground).toBe("#00afd7");
  });
});

// An agent the daemon is starting is not an agent asking for anything, and the
// app painted the two alike: `agentStatusKind` returned `needs` for any pending
// action, bypassing the mapping that already knew `starting` is work. The TUI
// had the same bug in `Tone::Attention`; both now use the working tone.
describe("an action in flight is work, not an ask", () => {
  it.each(TRANSIENT_ACTIONS)("%s renders as working", (action) => {
    expect(agentStatusKind({ pendingAction: action, status: "waiting" })).toBe("working");
    expect(serviceStatusKind({ pendingAction: action, status: "offline" })).toBe("working");
  });

  it("does not let a pending action borrow the attention tone", () => {
    for (const action of TRANSIENT_ACTIONS) {
      expect(agentStatusKind({ pendingAction: action, attention: "needs_input" })).not.toBe(
        "needs",
      );
    }
  });

  it("still lets a settled agent ask for attention", () => {
    expect(agentStatusKind({ status: "running", attention: "needs_input" })).toBe("needs");
  });

  it("does not let a blank action short-circuit attention", () => {
    expect(
      agentStatusKind({ pendingAction: "  ", status: "running", attention: "needs_input" }),
    ).toBe("needs");
  });

  it("renders work in the cyan the TUI uses for the same fact", () => {
    expect(appStatusColors("working").foreground).toBe("#00afd7");
    expect(appStatusColors("needs").foreground).toBe("#d7af5f");
  });
});
