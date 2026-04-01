import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { MetadataServer } from "./metadata-server.js";

describe("MetadataServer threads API", () => {
  let repoRoot = "";
  let server: MetadataServer | null = null;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-server-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    server = new MetadataServer();
    await server.start();
  });

  afterEach(() => {
    server?.stop();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("opens, sends, and reads threads over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const openRes = await fetch(`${base}/threads/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Review the API",
        from: "user",
        participants: ["codex-1"],
        kind: "conversation",
      }),
    });
    const opened = (await openRes.json()) as { thread: { id: string } };
    expect(openRes.ok).toBe(true);

    const sendRes = await fetch(`${base}/threads/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: opened.thread.id,
        from: "user",
        to: ["codex-1"],
        kind: "request",
        body: "Please inspect the parser error path.",
      }),
    });
    expect(sendRes.ok).toBe(true);

    const listRes = await fetch(`${base}/threads?session=codex-1`);
    const summaries = (await listRes.json()) as Array<{ thread: { id: string } }>;
    expect(listRes.ok).toBe(true);
    expect(summaries.some((summary) => summary.thread.id === opened.thread.id)).toBe(true);

    const showRes = await fetch(`${base}/threads/${opened.thread.id}`);
    const detail = (await showRes.json()) as { thread: { id: string }; messages: Array<{ body: string }> };
    expect(showRes.ok).toBe(true);
    expect(detail.thread.id).toBe(opened.thread.id);
    expect(detail.messages.at(-1)?.body).toContain("parser error path");
  });

  it("creates handoffs and task assignments over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const handoffRes = await fetch(`${base}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: ["codex-1"],
        body: "Take over the parser debugging path.",
        title: "Parser handoff",
      }),
    });
    const handoff = (await handoffRes.json()) as {
      thread: { id: string; kind: string };
      message: { kind: string };
    };
    expect(handoffRes.ok).toBe(true);
    expect(handoff.thread.kind).toBe("handoff");
    expect(handoff.message.kind).toBe("handoff");

    const taskRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Audit the parser timeout path",
      }),
    });
    const task = (await taskRes.json()) as {
      task: { id: string; threadId?: string };
      thread?: { id: string; kind: string };
    };
    expect(taskRes.ok).toBe(true);
    expect(task.task.id).toContain("task-");
    expect(task.task.threadId).toBeTruthy();
    expect(task.thread?.kind).toBe("task");
  });

  it("updates task lifecycle over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const taskRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Audit the parser timeout path",
      }),
    });
    const task = (await taskRes.json()) as { task: { id: string } };
    expect(taskRes.ok).toBe(true);

    const acceptRes = await fetch(`${base}/tasks/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: task.task.id, from: "codex-1" }),
    });
    const accepted = (await acceptRes.json()) as { task: { status: string } };
    expect(acceptRes.ok).toBe(true);
    expect(accepted.task.status).toBe("in_progress");

    const blockRes = await fetch(`${base}/tasks/block`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: task.task.id, from: "codex-1", body: "Need a repro case." }),
    });
    const blocked = (await blockRes.json()) as { task: { status: string } };
    expect(blockRes.ok).toBe(true);
    expect(blocked.task.status).toBe("blocked");

    const completeRes = await fetch(`${base}/tasks/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: task.task.id, from: "codex-1", body: "Fixed the timeout branch." }),
    });
    const completed = (await completeRes.json()) as { task: { status: string; result?: string } };
    expect(completeRes.ok).toBe(true);
    expect(completed.task.status).toBe("done");
    expect(completed.task.result).toContain("Fixed");
  });
});
