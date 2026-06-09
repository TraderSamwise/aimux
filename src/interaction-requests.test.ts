import { describe, expect, it } from "vitest";

import { InteractionRegistry } from "./interaction-requests.js";

describe("InteractionRegistry", () => {
  it("registers a pending request with a generated id and timestamp", () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ sessionId: "s1", type: "permission", payload: { toolName: "Bash" } });
    expect(req.id).toBeTruthy();
    expect(req.status).toBe("pending");
    expect(req.createdAt).toMatch(/T/);
    expect(reg.get(req.id)).toBe(req);
  });

  it("uses a supplied id when provided", () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ id: "fixed", sessionId: "s1", type: "input", payload: {} });
    expect(req.id).toBe("fixed");
  });

  it("lists only pending requests, filtered by session", () => {
    const reg = new InteractionRegistry();
    const a = reg.register({ sessionId: "s1", type: "permission", payload: { toolName: "Bash" } });
    reg.register({ sessionId: "s2", type: "permission", payload: { toolName: "Edit" } });
    reg.resolve(a.id, { decision: "allow_once" });
    const pending = reg.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe("s2");
    expect(reg.listPending("s1")).toHaveLength(0);
  });

  it("resolve sets status, response, and resolvedAt", () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ sessionId: "s1", type: "permission", payload: { toolName: "Bash" } });
    const resolved = reg.resolve(req.id, { decision: "deny", reason: "no" });
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.response).toEqual({ decision: "deny", reason: "no" });
    expect(resolved?.resolvedAt).toBeTruthy();
  });

  it("double resolve is a no-op that keeps the first decision", () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ sessionId: "s1", type: "permission", payload: { toolName: "Bash" } });
    reg.resolve(req.id, { decision: "allow_once" });
    expect(reg.resolve(req.id, { decision: "deny" })).toBeUndefined();
    expect(reg.get(req.id)?.response?.decision).toBe("allow_once");
  });

  it("wait returns immediately when already resolved", async () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ sessionId: "s1", type: "permission", payload: { toolName: "Bash" } });
    reg.resolve(req.id, { decision: "allow_always" });
    const result = await reg.wait(req.id, { timeoutMs: 1000 });
    expect(result.status).toBe("resolved");
    expect(result.response?.decision).toBe("allow_always");
  });

  it("wait resolves when respond happens after waiting starts", async () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ sessionId: "s1", type: "permission", payload: { toolName: "Bash" } });
    const waiting = reg.wait(req.id, { timeoutMs: 1000 });
    reg.resolve(req.id, { decision: "allow_once" });
    const result = await waiting;
    expect(result.status).toBe("resolved");
    expect(result.response?.decision).toBe("allow_once");
  });

  it("wait times out and marks the request timed_out", async () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ sessionId: "s1", type: "permission", payload: { toolName: "Bash" } });
    const result = await reg.wait(req.id, { timeoutMs: 10 });
    expect(result.status).toBe("timed_out");
    expect(reg.get(req.id)?.status).toBe("timed_out");
    expect(reg.listPending()).toHaveLength(0);
  });

  it("cancel marks cancelled and unblocks a waiter", async () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ sessionId: "s1", type: "question", payload: { question: "?" } });
    const waiting = reg.wait(req.id, { timeoutMs: 1000 });
    reg.cancel(req.id);
    const result = await waiting;
    expect(result.status).toBe("cancelled");
  });

  it("cancelSession cancels all pending requests for one session", () => {
    const reg = new InteractionRegistry();
    const a = reg.register({ sessionId: "s1", type: "permission", payload: { toolName: "Bash" } });
    const b = reg.register({ sessionId: "s1", type: "input", payload: {} });
    const c = reg.register({ sessionId: "s2", type: "input", payload: {} });
    reg.cancelSession("s1");
    expect(reg.get(a.id)?.status).toBe("cancelled");
    expect(reg.get(b.id)?.status).toBe("cancelled");
    expect(reg.get(c.id)?.status).toBe("pending");
  });

  it("prunes settled entries past the TTL on the next register", () => {
    const reg = new InteractionRegistry({ settledTtlMs: 0 });
    const a = reg.register({ sessionId: "s1", type: "input", payload: {} });
    reg.resolve(a.id, { decision: "deny" });
    expect(reg.get(a.id)?.status).toBe("resolved");
    reg.register({ sessionId: "s1", type: "input", payload: {} });
    expect(reg.get(a.id)).toBeUndefined();
  });

  it("keeps pending entries regardless of TTL", () => {
    const reg = new InteractionRegistry({ settledTtlMs: 0 });
    const a = reg.register({ sessionId: "s1", type: "input", payload: {} });
    reg.register({ sessionId: "s1", type: "input", payload: {} });
    expect(reg.get(a.id)?.status).toBe("pending");
  });

  it("wait aborts via signal", async () => {
    const reg = new InteractionRegistry();
    const req = reg.register({ sessionId: "s1", type: "input", payload: {} });
    const controller = new AbortController();
    const waiting = reg.wait(req.id, { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    const result = await waiting;
    expect(result.status).toBe("cancelled");
  });
});
