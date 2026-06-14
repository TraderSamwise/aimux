import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MetadataServer } from "./metadata-server.js";
import { initPaths } from "./paths.js";

async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function openWatcher(base: string): Promise<() => void> {
  const ac = new AbortController();
  const resp = await fetch(`${base}/agents/interaction/stream`, { signal: ac.signal });
  void (async () => {
    try {
      const reader = resp.body?.getReader();
      if (!reader) return;
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* connection aborted on cleanup */
    }
  })();
  return () => ac.abort();
}

describe("interaction endpoints", () => {
  let server: MetadataServer;
  let base: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-interaction-"));
    await initPaths(dir);
    server = new MetadataServer({ desktop: { getState: () => ({ sessions: [] }) } });
    await server.start();
    const addr = server.getAddress();
    if (!addr) throw new Error("server has no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    server.stop();
  });

  it("register then wait resolves when a respond lands", async () => {
    const reg = await postJson(`${base}/agents/interaction/register`, {
      session: "s1",
      type: "permission",
      payload: { toolName: "Bash" },
      summary: "Run ls",
    });
    expect(reg.json.ok).toBe(true);
    expect(reg.json.request.status).toBe("pending");
    const id = reg.json.request.id;

    const waiting = fetch(`${base}/agents/interaction/wait?id=${id}&timeoutMs=5000`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    const resp = await postJson(`${base}/agents/interaction/respond`, { id, response: { decision: "allow_once" } });
    expect(resp.json.ok).toBe(true);

    const waited = await waiting;
    expect(waited.ok).toBe(true);
    expect(waited.request.status).toBe("resolved");
    expect(waited.request.response.decision).toBe("allow_once");
  });

  it("pending lists the request and clears after respond", async () => {
    const reg = await postJson(`${base}/agents/interaction/register`, {
      session: "s2",
      type: "question",
      payload: { question: "?" },
    });
    const id = reg.json.request.id;

    const before = await (await fetch(`${base}/agents/interaction/pending`)).json();
    expect(before.requests.map((r: { id: string }) => r.id)).toContain(id);

    await postJson(`${base}/agents/interaction/respond`, { id, response: { selection: "yes" } });

    const after = await (await fetch(`${base}/agents/interaction/pending?sessionId=s2`)).json();
    expect(after.requests).toHaveLength(0);
  });

  it("formats AskUserQuestion payloads instead of storing raw JSON as the notification body", async () => {
    const payload = {
      questions: [
        {
          multiSelect: false,
          header: "New branch",
          question: "What should the new branch be named / for what work?",
          options: [
            { label: "Tell me the name", description: "You provide the branch name." },
            { label: "Neutral scratch branch", description: "Create a placeholder branch." },
          ],
        },
        {
          multiSelect: false,
          header: "Base branch",
          question: "Which base branch should this come from?",
          options: ["origin/master", "current HEAD"],
        },
      ],
    };
    const rawSummary = JSON.stringify(payload);

    const reg = await postJson(`${base}/agents/interaction/register`, {
      session: "codex-ask",
      type: "question",
      payload,
      summary: rawSummary,
    });
    expect(reg.json.ok).toBe(true);

    const listed = await (await fetch(`${base}/notifications?sessionId=codex-ask`)).json();
    expect(listed.notifications).toHaveLength(1);
    const notification = listed.notifications[0];
    expect(notification.title).toContain("[Question]");
    expect(notification.body).toContain("AskUserQuestion");
    expect(notification.body).toContain("1. What should the new branch be named / for what work?");
    expect(notification.body).toContain("Options: Tell me the name; Neutral scratch branch");
    expect(notification.body).toContain("2. Which base branch should this come from?");
    expect(notification.body).toContain("Options: origin/master; current HEAD");
    expect(notification.body).not.toContain('"questions"');
  });

  it("returns 409 for unknown respond and 400 for invalid register", async () => {
    const unknown = await postJson(`${base}/agents/interaction/respond`, { id: "nope", response: {} });
    expect(unknown.status).toBe(409);
    const invalid = await postJson(`${base}/agents/interaction/register`, {
      session: "",
      type: "permission",
      payload: {},
    });
    expect(invalid.status).toBe(400);
  });

  it("wait times out with a timed_out status", async () => {
    const reg = await postJson(`${base}/agents/interaction/register`, {
      session: "s3",
      type: "input",
      payload: {},
    });
    const waited = await (
      await fetch(`${base}/agents/interaction/wait?id=${reg.json.request.id}&timeoutMs=1000`)
    ).json();
    expect(waited.request.status).toBe("timed_out");
  });

  it("request without a watcher returns watching:false immediately", async () => {
    const settled = await (
      await fetch(`${base}/agents/interaction/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: "s7", type: "permission", payload: { toolName: "Bash" }, timeoutMs: 5000 }),
      })
    ).json();
    expect(settled).toEqual({ ok: true, watching: false });
    expect(settled.request).toBeUndefined();
  });

  it("request (register+wait) resolves in one call when a watcher responds", async () => {
    const stop = await openWatcher(base);
    const waiting = fetch(`${base}/agents/interaction/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "s5", type: "permission", payload: { toolName: "Bash" }, timeoutMs: 5000 }),
    }).then((r) => r.json());

    await new Promise((r) => setTimeout(r, 50));
    const pending = await (await fetch(`${base}/agents/interaction/pending?sessionId=s5`)).json();
    expect(pending.requests).toHaveLength(1);
    const id = pending.requests[0].id;

    await postJson(`${base}/agents/interaction/respond`, { id, response: { decision: "allow_once" } });
    const settled = await waiting;
    expect(settled.request.status).toBe("resolved");
    expect(settled.request.response.decision).toBe("allow_once");
    stop();
  });

  it("request times out and returns timed_out when a watcher never responds", async () => {
    const stop = await openWatcher(base);
    const settled = await (
      await fetch(`${base}/agents/interaction/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: "s6", type: "permission", payload: {}, timeoutMs: 1000 }),
      })
    ).json();
    expect(settled.request.status).toBe("timed_out");
    stop();
  });

  it("rejects a non-object payload or response with 400", async () => {
    const badPayload = await postJson(`${base}/agents/interaction/register`, {
      session: "s4",
      type: "input",
      payload: "nope",
    });
    expect(badPayload.status).toBe(400);

    const reg = await postJson(`${base}/agents/interaction/register`, { session: "s4", type: "input", payload: {} });
    const badResponse = await postJson(`${base}/agents/interaction/respond`, {
      id: reg.json.request.id,
      response: "nope",
    });
    expect(badResponse.status).toBe(400);
  });
});
