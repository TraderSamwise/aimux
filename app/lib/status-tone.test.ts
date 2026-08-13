import { describe, expect, it } from "vitest";
import { agentStatusKind, aggregateStatusKind, serviceStatusKind } from "./status-tone";

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
    expect(agentStatusKind({ status: "running", attention: "error" })).toBe("error");
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
});
