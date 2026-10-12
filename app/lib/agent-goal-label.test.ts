import { describe, expect, it } from "vitest";

import { agentGoalLabel } from "./agent-goal-label";

describe("how a goal reads at a glance", () => {
  it("says nothing special about the kind the loop always had", () => {
    expect(agentGoalLabel({ loop: { active: true, goal: "ship it" } })).toBe("ship it");
  });

  // The whole point: a user-managed goal was indistinguishable from an
  // agent-managed one until a refusal arrived.
  it("calls out a goal that is not the agent's to close", () => {
    expect(
      agentGoalLabel({ loop: { active: true, goal: "the long migration", goalKind: "user" } }),
    ).toBe("Yours to close: the long migration");
  });

  it("shows a token goal's standing against its budget", () => {
    expect(
      agentGoalLabel({
        loop: { active: true, goal: "spend down", goalKind: "tokens", tokenBudget: 50000 },
        tokenSpend: { billed: 12500 },
      }),
    ).toBe("spend down — 12,500 of 50,000 tokens");
  });

  // aider and shell report no usage, and a fresh baseline has nothing yet.
  it("says the spend is unmeasured rather than showing it as zero", () => {
    const label = agentGoalLabel({
      loop: { active: true, goal: "spend down", goalKind: "tokens", tokenBudget: 50000 },
      tokenSpend: { unmeasured: "this runtime does not report token usage" },
    });
    expect(label).toContain("not measured");
    expect(label).not.toContain("0 of");
  });

  // The Rust rule falls back CLOSED on a word it does not know, so that a
  // newer build's user-managed goal is not shown here as the agent's to end.
  it("reads a kind it does not know as yours to close", () => {
    expect(
      agentGoalLabel({ loop: { active: true, goal: "whatever this is", goalKind: "whenever" } }),
    ).toBe("Yours to close: whatever this is");
  });

  // Same verdict the Rust rule reaches: a token kind whose budget did not
  // survive is not a free-for-all.
  it("reads a token goal with no surviving budget as yours to close", () => {
    expect(agentGoalLabel({ loop: { active: true, goal: "spend down", goalKind: "tokens" } })).toBe(
      "Yours to close: spend down",
    );
    expect(
      agentGoalLabel({
        loop: { active: true, goal: "spend down", goalKind: "tokens", tokenBudget: 0 },
      }),
    ).toBe("Yours to close: spend down");
  });

  it("does not claim a goal for a session that is not in a loop", () => {
    expect(agentGoalLabel({ loop: { active: false, goal: "stale" } })).toBe("Not in a loop");
    expect(agentGoalLabel({})).toBe("Not in a loop");
  });

  it("still distinguishes a kind when there is no goal text", () => {
    expect(agentGoalLabel({ loop: { active: true, goalKind: "user" } })).toBe(
      "Yours to close, no goal set",
    );
    expect(agentGoalLabel({ loop: { active: true } })).toBe("Watching without a goal");
  });
});
