import { describe, expect, it } from "vitest";
import {
  deriveSessionSemantics,
  sessionSemanticAttentionScore,
  sessionSemanticCompactHint,
  sessionSemanticStatusLabel,
} from "./session-semantics.js";

describe("session semantics", () => {
  it("keeps explicit needs-input as user attention without making workflow authoritative", () => {
    const semantic = deriveSessionSemantics({
      status: "idle",
      attention: "needs_input",
      unseenCount: 1,
      workflowOnMeCount: 1,
    });

    expect(semantic.runtime.canReceiveInput).toBe(true);
    expect(semantic.user.label).toBe("needs_input");
    expect(semantic.orchestration.pressure).toBe("waiting_on_user");
    expect(sessionSemanticStatusLabel(semantic, "idle")).toBe("needs input");
    expect(sessionSemanticAttentionScore(semantic)).toBe(4);
  });

  it("keeps blocked workflow as orchestration pressure instead of primary user state", () => {
    const semantic = deriveSessionSemantics({
      status: "idle",
      workflowBlockedCount: 1,
    });

    expect(semantic.runtime.canReceiveInput).toBe(true);
    expect(semantic.user.label).toBe("idle");
    expect(semantic.orchestration.pressure).toBe("blocked");
    expect(sessionSemanticStatusLabel(semantic, "idle")).toBe("idle");
    expect(sessionSemanticCompactHint(semantic)).toBe("blocked task");
  });

  it("blocks input only for real tool/runtime blockers", () => {
    const semantic = deriveSessionSemantics({
      status: "running",
      attention: "blocked",
    });

    expect(semantic.runtime.canReceiveInput).toBe(false);
    expect(semantic.user.label).toBe("blocked");
  });

  it("treats idle task-free sessions as assignable", () => {
    const semantic = deriveSessionSemantics({
      status: "idle",
      attention: "normal",
    });

    expect(semantic.runtime.canReceiveInput).toBe(true);
    expect(semantic.orchestration.canBeAssignedWork).toBe(true);
    expect(sessionSemanticAttentionScore(semantic)).toBe(0);
  });

  it("separates notification unread from raw new activity", () => {
    const notificationSemantic = deriveSessionSemantics({
      status: "idle",
      attention: "normal",
      notificationUnreadCount: 3,
    });
    const activitySemantic = deriveSessionSemantics({
      status: "idle",
      attention: "normal",
      unseenCount: 3,
    });

    expect(sessionSemanticCompactHint(notificationSemantic)).toBe("3 unread");
    expect(sessionSemanticCompactHint(activitySemantic)).toBe("3 new");
  });
});
