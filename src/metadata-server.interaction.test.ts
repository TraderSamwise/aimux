import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MetadataServer } from "./metadata-server.js";
import { loadMetadataState } from "./metadata-store.js";
import { initPaths } from "./paths.js";
import { ProjectEventBus, type AlertEvent } from "./project-events.js";

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

  it("dedupes repeated interaction alerts with the same session and payload", async () => {
    const bus = new ProjectEventBus();
    const events: AlertEvent[] = [];
    bus.subscribe((event) => {
      if (event.type === "alert") events.push(event);
    });
    server.stop();
    server = new MetadataServer({ events: { bus }, desktop: { getState: () => ({ sessions: [] }) } });
    await server.start();
    const addr = server.getAddress();
    if (!addr) throw new Error("server has no address");
    base = `http://127.0.0.1:${addr.port}`;

    const payload = { toolName: "Bash", input: { command: "ls" } };
    const body = {
      session: "s4",
      type: "permission",
      payload,
      summary: "Run ls",
    };
    const first = (await postJson(`${base}/agents/interaction/register`, body)).json;
    const second = (await postJson(`${base}/agents/interaction/register`, body)).json;
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    expect(events.filter((event) => event.kind === "interaction_request")).toHaveLength(1);
    expect(second.request.id).toBe(first.request.id);
    const pending = await (await fetch(`${base}/agents/interaction/pending?sessionId=s4`)).json();
    expect(pending.requests).toHaveLength(1);
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

  it("resolves Claude permission hooks through the project service", async () => {
    const stop = await openWatcher(base);
    const waiting = postJson(`${base}/hooks/claude?action=permission-request&sessionId=claude-1`, {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: "/tmp/worktree",
    });

    await new Promise((r) => setTimeout(r, 50));
    const pending = await (await fetch(`${base}/agents/interaction/pending?sessionId=claude-1`)).json();
    expect(pending.requests).toHaveLength(1);

    await postJson(`${base}/agents/interaction/respond`, {
      id: pending.requests[0].id,
      response: { decision: "allow_once" },
    });
    const settled = await waiting;
    expect(settled.status).toBe(200);
    expect(settled.json).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    stop();
  });

  it("keeps Codex permission hooks telemetry-only without stranded response attention", async () => {
    const started = await postJson(`${base}/hooks/codex?action=prompt-submit&sessionId=codex-1`, {
      session_id: "codex-backend-1",
    });
    expect(started.status).toBe(200);

    const response = await postJson(`${base}/hooks/codex?action=permission-request&sessionId=codex-1`, {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: "/tmp/worktree",
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({});

    const pending = await (await fetch(`${base}/agents/interaction/pending?sessionId=codex-1`)).json();
    expect(pending.requests).toHaveLength(0);
    const session = loadMetadataState().sessions["codex-1"];
    expect(session).toBeDefined();
    expect(session?.derived).toBeDefined();
    expect(session?.derived?.attention).not.toBe("needs_response");
  });

  it("records backend session ids from hook payloads without a CLI adapter", async () => {
    const recorded: Array<{ sessionId: string; backendSessionId: string }> = [];
    server.stop();
    server = new MetadataServer({
      desktop: { getState: () => ({ sessions: [] }) },
      lifecycle: {
        recordBackendSessionId: (input) => {
          recorded.push(input);
          return input;
        },
      },
    });
    await server.start();
    const addr = server.getAddress();
    if (!addr) throw new Error("server has no address");
    base = `http://127.0.0.1:${addr.port}`;

    const response = await postJson(`${base}/hooks/codex?action=prompt-submit&sessionId=codex-1`, {
      session_id: "codex-backend-1",
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({});
    expect(recorded).toEqual([{ sessionId: "codex-1", backendSessionId: "codex-backend-1" }]);
  });

  it("accepts hook session ids from the generated hook header", async () => {
    const response = await fetch(`${base}/hooks/codex?action=prompt-submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aimux-session-id": "codex-header-1",
      },
      body: JSON.stringify({ session_id: "codex-backend-header-1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(loadMetadataState().sessions["codex-header-1"]?.derived?.activity).toBe("running");
  });

  it("does not fail hook handling when backend session recording fails", async () => {
    server.stop();
    server = new MetadataServer({
      desktop: { getState: () => ({ sessions: [] }) },
      lifecycle: {
        recordBackendSessionId: () => {
          throw new Error("write failed");
        },
      },
    });
    await server.start();
    const addr = server.getAddress();
    if (!addr) throw new Error("server has no address");
    base = `http://127.0.0.1:${addr.port}`;

    const response = await postJson(`${base}/hooks/claude?action=session-start&sessionId=claude-1`, {
      session_id: "claude-backend-1",
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({});
  });
});
