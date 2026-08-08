import { describe, expect, it } from "vitest";

import { agentActivityLabel } from "./activity-label";

describe("agentActivityLabel", () => {
  it("prefers the tool's own words while a turn is running", () => {
    expect(agentActivityLabel("running", "Jitterbugging… (2m 23s · ↓ 8.1k tokens)")).toBe(
      "Jitterbugging… (2m 23s · ↓ 8.1k tokens)",
    );
  });

  it("still says something when the tool offers no words", () => {
    expect(agentActivityLabel("running", "")).toBe("Working…");
  });

  it("does not let a stale spinner speak over a session waiting on the operator", () => {
    // The pane keeps its last frame painted, so an approval prompt still reads
    // "Brewing…". What the operator needs to know there is that it wants them.
    expect(agentActivityLabel("waiting", "Brewing…")).toBe("Waiting for input");
    expect(agentActivityLabel("error", "Brewing…")).toBe("Stopped on an error");
    expect(agentActivityLabel("interrupted", "Brewing…")).toBe("Interrupted");
  });

  it("claims nothing when the service does not report activity", () => {
    // Absence means unreported, not idle, so a leftover verb must not fill in.
    expect(agentActivityLabel(undefined, "Brewing…")).toBeNull();
    expect(agentActivityLabel("idle", "Brewing…")).toBeNull();
    expect(agentActivityLabel("done", "Brewing…")).toBeNull();
  });
});
