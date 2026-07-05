import { describe, expect, it } from "vitest";
import {
  deriveSessionSemantics,
  sessionDisplayStatusLabel,
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

  it("distinguishes plain response waits from formal input prompts", () => {
    const semantic = deriveSessionSemantics({
      status: "idle",
      attention: "needs_response",
    });

    expect(semantic.user.label).toBe("needs_response");
    expect(semantic.user.attention).toBe("needs_response");
    expect(sessionSemanticStatusLabel(semantic, "idle")).toBe("needs answer");
    expect(sessionSemanticCompactHint(semantic)).toBe("answer");
    expect(sessionSemanticAttentionScore(semantic)).toBe(4);
  });

  it("labels idle assigned-task sessions as needing a next step", () => {
    const semantic = deriveSessionSemantics({
      status: "idle",
      attention: "normal",
      hasActiveTask: true,
    });

    expect(semantic.user.label).toBe("next_step");
    expect(semantic.user.attention).toBe("none");
    expect(sessionSemanticStatusLabel(semantic, "idle")).toBe("next step");
    expect(sessionSemanticCompactHint(semantic)).toBe("on you");
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

  it("labels alive sessions without active work as ready", () => {
    const semantic = deriveSessionSemantics({
      status: "running",
      attention: "normal",
    });

    expect(semantic.user.label).toBe("ready");
    expect(semantic.user.attention).toBe("none");
    expect(sessionSemanticStatusLabel(semantic, "running")).toBe("ready");
    expect(sessionSemanticAttentionScore(semantic)).toBe(0);
  });

  it("keeps explicit activity as working", () => {
    const semantic = deriveSessionSemantics({
      status: "running",
      activity: "running",
      attention: "normal",
    });

    expect(semantic.user.label).toBe("working");
    expect(sessionSemanticStatusLabel(semantic, "running")).toBe("working");
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

  it("accepts API-provided latest notification text without a local notification record", () => {
    const semantic = deriveSessionSemantics({
      status: "running",
      notificationUnreadCount: 1,
      latestNotificationText: "Claude needs input",
    });

    expect(semantic.notifications.unreadCount).toBe(1);
    expect(semantic.notifications.latestText).toBe("Claude needs input");
    expect(semantic.notifications.latestUnread).toBeUndefined();
    expect(sessionSemanticCompactHint(semantic)).toBe("1 unread");
  });

  it("keeps raw dashboard status fallback labels in the semantic display helper", () => {
    expect(sessionDisplayStatusLabel({ status: "running" })).toBe("running");
    expect(sessionDisplayStatusLabel({ status: "idle" })).toBe("idle");
    expect(sessionDisplayStatusLabel({ status: "waiting" })).toBe("thinking");
    expect(sessionDisplayStatusLabel({ status: "exited" })).toBe("exited");
    expect(sessionDisplayStatusLabel({ status: "offline" })).toBe("offline");
  });

  it("keeps pending action labels authoritative over semantic user state", () => {
    const semantic = deriveSessionSemantics({
      status: "running",
      attention: "needs_input",
    });

    expect(sessionDisplayStatusLabel({ status: "running", semantic })).toBe("needs input");
    for (const pendingAction of [
      "creating",
      "forking",
      "migrating",
      "starting",
      "stopping",
      "graveyarding",
      "renaming",
    ] as const) {
      expect(sessionDisplayStatusLabel({ status: "running", pendingAction, semantic })).toBe(pendingAction);
    }
  });
});
