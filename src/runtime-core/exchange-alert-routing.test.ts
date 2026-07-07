import { describe, expect, it } from "vitest";
import {
  resolveExchangeMessageAlertRecipients,
  resolveExchangeReviewOutcomeRecipient,
  resolveExchangeTaskAssignmentRecipient,
  resolveExchangeTaskOutcomeRecipient,
} from "./exchange-alert-routing.js";

describe("exchange alert routing", () => {
  it("prefers explicit message recipients and excludes the sender", () => {
    expect(
      resolveExchangeMessageAlertRecipients({
        explicitRecipients: [" codex-1 ", "claude-lead", "codex-1"],
        message: { deliveredTo: ["ignored"] },
        fallbackRecipients: ["fallback"],
        from: "claude-lead",
      }),
    ).toEqual(["codex-1"]);
  });

  it("falls back through delivered recipients, waiting actors, message recipients, and route recipients", () => {
    expect(resolveExchangeMessageAlertRecipients({ message: { deliveredTo: ["codex-1"] } })).toEqual(["codex-1"]);
    expect(resolveExchangeMessageAlertRecipients({ thread: { waitingOn: ["reviewer"] } })).toEqual(["reviewer"]);
    expect(resolveExchangeMessageAlertRecipients({ message: { to: ["claude-2"] } })).toEqual(["claude-2"]);
    expect(resolveExchangeMessageAlertRecipients({ fallbackRecipients: ["fallback-1"] })).toEqual(["fallback-1"]);
  });

  it("does not fall through from an authoritative source that only targets the sender", () => {
    expect(
      resolveExchangeMessageAlertRecipients({
        explicitRecipients: ["claude-lead"],
        message: { deliveredTo: ["codex-1"] },
        from: "claude-lead",
      }),
    ).toEqual([]);
    expect(
      resolveExchangeMessageAlertRecipients({
        message: { deliveredTo: ["claude-lead"], to: ["codex-1"] },
        from: "claude-lead",
      }),
    ).toEqual([]);
    expect(
      resolveExchangeMessageAlertRecipients({
        thread: { waitingOn: ["claude-lead"] },
        message: { to: ["codex-1"] },
        from: "claude-lead",
      }),
    ).toEqual([]);
  });

  it("resolves task alert actors from exchange task fields", () => {
    expect(resolveExchangeTaskAssignmentRecipient({ assignedTo: " codex-1 " })).toBe("codex-1");
    expect(resolveExchangeTaskAssignmentRecipient({})).toBeUndefined();
    expect(resolveExchangeTaskOutcomeRecipient({ task: { assignedBy: "claude-lead" } })).toBe("claude-lead");
    expect(
      resolveExchangeTaskOutcomeRecipient({
        task: { assignedBy: "fallback-lead" },
        thread: { waitingOn: ["claude-lead"] },
        from: "codex-1",
      }),
    ).toBe("claude-lead");
    expect(resolveExchangeReviewOutcomeRecipient({ assignedBy: " claude-lead " })).toBe("claude-lead");
  });
});
