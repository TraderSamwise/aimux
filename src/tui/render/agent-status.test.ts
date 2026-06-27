import { describe, expect, it } from "vitest";
import { agentStatusChip, renderAgentStatusChip } from "./agent-status.js";
import { stripAnsi } from "./text.js";

describe("agentStatusChip", () => {
  it("maps every activity state to a chip", () => {
    expect(agentStatusChip({ activity: "running" })).toEqual({ kind: "working", label: "Working" });
    expect(agentStatusChip({ activity: "waiting" })).toEqual({ kind: "needs", label: "Waiting" });
    expect(agentStatusChip({ activity: "done" })).toEqual({ kind: "done", label: "Done" });
    expect(agentStatusChip({ activity: "idle" })).toEqual({ kind: "idle", label: "Idle" });
    expect(agentStatusChip({ activity: "error" })).toEqual({ kind: "error", label: "Error" });
    expect(agentStatusChip({ activity: "interrupted" })).toEqual({ kind: "idle", label: "Interrupted" });
  });

  it("prefers attention over activity", () => {
    expect(agentStatusChip({ activity: "running", attention: "needs_input" })).toEqual({
      kind: "needs",
      label: "Needs input",
    });
    expect(agentStatusChip({ activity: "running", attention: "error" })).toEqual({ kind: "error", label: "Error" });
    expect(agentStatusChip({ activity: "idle", attention: "blocked" })).toEqual({ kind: "blocked", label: "Blocked" });
  });

  it("ignores non-signal attention values and falls through to activity", () => {
    expect(agentStatusChip({ activity: "running", attention: "none" })).toEqual({ kind: "working", label: "Working" });
    expect(agentStatusChip({ activity: "done", attention: "idle" })).toEqual({ kind: "done", label: "Done" });
  });

  it("returns null when there is no known state", () => {
    expect(agentStatusChip({})).toBeNull();
    expect(agentStatusChip({ activity: "bogus" })).toBeNull();
  });

  it("prefers the dashboard-semantic user label over raw activity/attention", () => {
    // The dashboard reinterprets activity:"waiting" as "working" and alive-idle as "ready";
    // the user label wins so Exposé matches the dashboard.
    expect(agentStatusChip({ activity: "waiting", userLabel: "working" })).toEqual({
      kind: "working",
      label: "Working",
    });
    expect(agentStatusChip({ activity: "idle", userLabel: "ready" })).toEqual({ kind: "ready", label: "Ready" });
    // Also wins over an attention signal, not just activity.
    expect(agentStatusChip({ attention: "needs_input", userLabel: "working" })).toEqual({
      kind: "working",
      label: "Working",
    });
    expect(agentStatusChip({ userLabel: "next_step" })).toEqual({ kind: "needs", label: "Next step" });
    expect(agentStatusChip({ userLabel: "offline" })).toEqual({ kind: "offline", label: "Offline" });
  });
});

describe("renderAgentStatusChip", () => {
  it("renders a dot + label whose visible text is the label", () => {
    const rendered = renderAgentStatusChip({ activity: "running" });
    expect(stripAnsi(rendered)).toContain("Working");
    expect(rendered).toContain("\x1b["); // carries color
  });

  it("renders empty string for unknown state", () => {
    expect(renderAgentStatusChip({})).toBe("");
  });
});
