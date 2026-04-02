import { describe, expect, it } from "vitest";
import {
  deriveSessionSemantics,
  sessionSemanticAttentionScore,
  sessionSemanticStatusLabel,
} from "./session-semantics.js";

describe("session semantics", () => {
  it("marks sessions waiting on the user as needs_input availability", () => {
    const semantic = deriveSessionSemantics({
      status: "idle",
      attention: "needs_input",
      unseenCount: 1,
      workflowOnMeCount: 1,
    });

    expect(semantic.availability).toBe("needs_input");
    expect(semantic.workflowState).toBe("waiting_on_me");
    expect(sessionSemanticStatusLabel(semantic, "idle")).toBe("needs input");
    expect(sessionSemanticAttentionScore(semantic)).toBe(4);
  });

  it("treats blocked workflow as blocked even if runtime is idle", () => {
    const semantic = deriveSessionSemantics({
      status: "idle",
      workflowBlockedCount: 1,
    });

    expect(semantic.availability).toBe("blocked");
    expect(semantic.workflowState).toBe("blocked");
    expect(sessionSemanticStatusLabel(semantic, "idle")).toBe("blocked");
  });

  it("treats idle task-free sessions as available", () => {
    const semantic = deriveSessionSemantics({
      status: "idle",
      attention: "normal",
    });

    expect(semantic.availability).toBe("available");
    expect(semantic.workflowState).toBe("none");
    expect(sessionSemanticAttentionScore(semantic)).toBe(0);
  });
});
