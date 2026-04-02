import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { MetadataServer } from "./metadata-server.js";

async function readSseUntil(stream: ReadableStream<Uint8Array>, predicate: (text: string) => boolean): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) return text;
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}

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

  it("handles review approval, changes, and reopen over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const reviewRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Review the parser timeout patch",
        type: "review",
      }),
    });
    const review = (await reviewRes.json()) as { task: { id: string } };
    expect(reviewRes.ok).toBe(true);

    const approveRes = await fetch(`${base}/reviews/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: review.task.id, from: "codex-1", body: "Looks good." }),
    });
    const approved = (await approveRes.json()) as { task: { status: string; reviewStatus: string } };
    expect(approveRes.ok).toBe(true);
    expect(approved.task.status).toBe("done");
    expect(approved.task.reviewStatus).toBe("approved");

    const reviewRes2 = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Review the parser timeout follow-up",
        type: "review",
      }),
    });
    const review2 = (await reviewRes2.json()) as { task: { id: string } };

    const changesRes = await fetch(`${base}/reviews/request-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: review2.task.id, from: "codex-1", body: "Please tighten the tests." }),
    });
    const changes = (await changesRes.json()) as { task: { reviewStatus: string }; followUpTask?: { id: string } };
    expect(changesRes.ok).toBe(true);
    expect(changes.task.reviewStatus).toBe("changes_requested");
    expect(changes.followUpTask?.id).toBeTruthy();

    const reopenRes = await fetch(`${base}/tasks/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: review2.task.id, from: "claude-lead", body: "Try another pass." }),
    });
    const reopened = (await reopenRes.json()) as { task: { id: string; status: string } };
    expect(reopenRes.ok).toBe(true);
    expect(reopened.task.id).not.toBe(review2.task.id);
    expect(reopened.task.status).toBe("pending");
  });

  it("returns workflow entries over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Audit the parser timeout path",
      }),
    });

    const workflowRes = await fetch(`${base}/workflow?participant=codex-1`);
    const workflow = (await workflowRes.json()) as Array<{
      thread: { kind: string };
      task?: { status: string };
      stateLabel: string;
    }>;
    expect(workflowRes.ok).toBe(true);
    expect(workflow.some((entry) => entry.thread.kind === "task")).toBe(true);
    expect(workflow.some((entry) => entry.stateLabel.includes("on codex-1") || entry.stateLabel === "on me")).toBe(
      true,
    );
  });

  it("writes agent input and reads agent output over HTTP", async () => {
    server?.stop();
    const writes: Array<{ sessionId: string; data: string }> = [];
    server = new MetadataServer({
      lifecycle: {
        writeAgentInput: ({ sessionId, data }) => {
          writes.push({ sessionId, data });
          return { sessionId };
        },
        readAgentOutput: ({ sessionId, startLine }) => ({
          sessionId,
          startLine: startLine ?? -120,
          output: `output for ${sessionId} @ ${startLine ?? -120}`,
          parsed: {
            blocks: [
              { type: "prompt", text: "write me a poem" },
              { type: "response", text: `output for ${sessionId} @ ${startLine ?? -120}` },
            ],
            parser: {
              tool: "codex",
              version: 1,
              confidence: "heuristic" as const,
            },
          },
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const inputRes = await fetch(`${base}/agents/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "codex-1",
        data: "hello\r",
      }),
    });
    const inputJson = (await inputRes.json()) as { ok: boolean; sessionId: string };
    expect(inputRes.ok).toBe(true);
    expect(inputJson.sessionId).toBe("codex-1");
    expect(writes).toEqual([{ sessionId: "codex-1", data: "hello\r" }]);

    const outputRes = await fetch(`${base}/agents/output?sessionId=codex-1&startLine=-80`);
    const outputJson = (await outputRes.json()) as {
      ok: boolean;
      sessionId: string;
      startLine: number;
      output: string;
      parsed: {
        blocks: Array<{ type: string; text: string }>;
        parser: { tool: string; version: number; confidence: string };
      };
    };
    expect(outputRes.ok).toBe(true);
    expect(outputJson.sessionId).toBe("codex-1");
    expect(outputJson.startLine).toBe(-80);
    expect(outputJson.output).toContain("codex-1");
    expect(outputJson.parsed.blocks).toEqual([
      { type: "prompt", text: "write me a poem" },
      { type: "response", text: "output for codex-1 @ -80" },
    ]);
    expect(outputJson.parsed.parser).toMatchObject({
      tool: "codex",
      version: 1,
      confidence: "heuristic",
    });
  });

  it("passes submit intent with agent input over HTTP", async () => {
    server?.stop();
    const writes: Array<{ sessionId: string; data: string; submit?: boolean }> = [];
    server = new MetadataServer({
      lifecycle: {
        writeAgentInput: ({ sessionId, data, submit }) => {
          writes.push({ sessionId, data, submit });
          return { sessionId };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const inputRes = await fetch(`${base}/agents/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "codex-1",
        data: "hello from http",
        submit: true,
      }),
    });
    expect(inputRes.ok).toBe(true);
    expect(writes).toEqual([{ sessionId: "codex-1", data: "hello from http", submit: true }]);
  });

  it("passes structured input parts with agent input over HTTP", async () => {
    server?.stop();
    const writes: Array<{
      sessionId: string;
      data?: string;
      parts?: Array<Record<string, unknown>>;
      submit?: boolean;
    }> = [];
    server = new MetadataServer({
      lifecycle: {
        writeAgentInput: ({ sessionId, data, parts, submit }) => {
          writes.push({ sessionId, data, parts, submit });
          return { sessionId };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const inputRes = await fetch(`${base}/agents/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "claude-1",
        parts: [
          { type: "text", text: "Compare these" },
          { type: "image", url: "https://example.com/a.png", alt: "first screenshot" },
          { type: "text", text: "against this one" },
        ],
        submit: true,
      }),
    });

    expect(inputRes.ok).toBe(true);
    expect(writes).toEqual([
      {
        sessionId: "claude-1",
        data: undefined,
        parts: [
          { type: "text", text: "Compare these" },
          { type: "image", url: "https://example.com/a.png", alt: "first screenshot" },
          { type: "text", text: "against this one" },
        ],
        submit: true,
      },
    ]);
  });

  it("ingests path attachments and serves metadata plus content over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const imagePath = join(repoRoot, "shot.png");
    const imageBytes = Buffer.from("fake-image-bytes");
    writeFileSync(imagePath, imageBytes);

    const createRes = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: imagePath }),
    });
    const created = (await createRes.json()) as {
      ok: boolean;
      attachment: { id: string; filename: string; mimeType: string; contentUrl: string };
    };
    expect(createRes.ok).toBe(true);
    expect(created.attachment.id).toContain("att_");
    expect(created.attachment.filename).toBe("shot.png");
    expect(created.attachment.mimeType).toBe("image/png");

    const showRes = await fetch(`${base}/attachments/${created.attachment.id}`);
    const shown = (await showRes.json()) as { ok: boolean; attachment: { id: string; contentUrl: string } };
    expect(showRes.ok).toBe(true);
    expect(shown.attachment.id).toBe(created.attachment.id);
    expect(shown.attachment.contentUrl).toBe(`/attachments/${created.attachment.id}/content`);

    const contentRes = await fetch(`${base}${created.attachment.contentUrl}`);
    const contentBytes = Buffer.from(await contentRes.arrayBuffer());
    expect(contentRes.ok).toBe(true);
    expect(contentRes.headers.get("content-type")).toBe("image/png");
    expect(contentBytes.equals(imageBytes)).toBe(true);
  });

  it("ingests base64 attachments over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const createRes = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "clip.webp",
        mimeType: "image/webp",
        contentBase64: Buffer.from("webp-ish").toString("base64"),
      }),
    });
    const created = (await createRes.json()) as {
      ok: boolean;
      attachment: { id: string; filename: string; mimeType: string };
    };
    expect(createRes.ok).toBe(true);
    expect(created.attachment.filename).toBe("clip.webp");
    expect(created.attachment.mimeType).toBe("image/webp");
  });

  it("validates agent output query parameters over HTTP", async () => {
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        readAgentOutput: ({ sessionId, startLine }) => ({
          sessionId,
          startLine,
          output: "",
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const missingRes = await fetch(`${base}/agents/output`);
    expect(missingRes.status).toBe(400);
    await expect(missingRes.json()).resolves.toMatchObject({
      ok: false,
      error: "sessionId is required",
    });

    const invalidRes = await fetch(`${base}/agents/output?sessionId=codex-1&startLine=abc`);
    expect(invalidRes.status).toBe(400);
    await expect(invalidRes.json()).resolves.toMatchObject({
      ok: false,
      error: "startLine must be an integer",
    });
  });

  it("reads agent history over HTTP", async () => {
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        readAgentHistory: ({ sessionId, lastN }) => ({
          sessionId,
          lastN: lastN ?? 20,
          messages: [
            {
              id: "msg_1",
              role: "user",
              parts: [{ type: "text", text: "what is in this image?" }],
            },
          ],
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const historyRes = await fetch(`${base}/agents/history?sessionId=claude-1&lastN=5`);
    const historyJson = (await historyRes.json()) as {
      ok: boolean;
      sessionId: string;
      lastN: number;
      messages: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }>;
    };
    expect(historyRes.ok).toBe(true);
    expect(historyJson.sessionId).toBe("claude-1");
    expect(historyJson.lastN).toBe(5);
    expect(historyJson.messages[0]?.parts[0]?.text).toBe("what is in this image?");
  });

  it("streams agent output over SSE", async () => {
    server?.stop();
    let reads = 0;
    server = new MetadataServer({
      lifecycle: {
        readAgentOutput: ({ sessionId, startLine }) => {
          reads += 1;
          return {
            sessionId,
            startLine: startLine ?? -120,
            output: reads >= 2 ? "updated output" : "initial output",
            parsed: {
              blocks: [{ type: "response", text: reads >= 2 ? "updated output" : "initial output" }],
              parser: {
                tool: "codex",
                version: 1,
                confidence: "heuristic" as const,
              },
            },
          };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const controller = new AbortController();

    const res = await fetch(`${base}/agents/output/stream?sessionId=codex-1&startLine=-50&intervalMs=100`, {
      signal: controller.signal,
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).toBeTruthy();

    const text = await readSseUntil(res.body!, (value) => value.includes('"output":"updated output"'));
    controller.abort();

    expect(text).toContain("event: ready");
    expect(text).toContain('"sessionId":"codex-1"');
    expect(text).toContain('"startLine":-50');
    expect(text).toContain("event: output");
    expect(text).toContain('"output":"updated output"');
    expect(text).toContain(
      '"parsed":{"blocks":[{"type":"response","text":"updated output"}],"parser":{"tool":"codex","version":1,"confidence":"heuristic"}}',
    );
  });
});
