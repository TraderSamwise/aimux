import { describe, expect, it } from "vitest";
import {
  TRANSIENT_ACTIONS,
  aggregateStatusKind,
  appStatusColors,
  serviceStatusKind,
} from "./status-tone";

describe("status-tone", () => {
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
// app painted the two alike: it returned `needs` for any pending action,
// bypassing the mapping that already knew `starting` is work. The TUI had the
// same bug in `Tone::Attention`; both use the working tone now.
//
// Only the service half is left here. The agent half moved to
// `deriveAgentState`, which is where production answers this question, and is
// asserted through that function in `transient-state.cross-surface.test.ts` and
// `agent-status-label.cross-surface.test.ts`.
describe("an action in flight is work, not an ask", () => {
  it.each(TRANSIENT_ACTIONS)("%s renders as working", (action) => {
    expect(serviceStatusKind({ pendingAction: action, status: "offline" })).toBe("working");
  });

  it("renders work in the cyan the TUI uses for the same fact", () => {
    expect(appStatusColors("working").foreground).toBe("#00afd7");
    expect(appStatusColors("needs").foreground).toBe("#d7af5f");
  });
});
