import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDashboardClientUiStatePath, getPlansDir, initPaths } from "./paths.js";
import { MetadataServer } from "./metadata-server.js";
import { loadMetadataState, updateSessionMetadata } from "./metadata-store.js";
import { listNotifications, upsertNotification } from "./notifications.js";
import { readTask } from "./tasks.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import { parseAgentOutput } from "./agent-output-parser.js";
import { getParserFixture } from "./agent-output-parser-test-utils.js";
import {
  moveTopologySessionToGraveyard,
  saveRuntimeTopologySessions,
  upsertTopologySession,
} from "./runtime-core/topology-sessions.js";

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

  function seedAgentTopology(
    sessions: Array<{
      id: string;
      command?: string;
      status?: "running" | "idle" | "offline";
      team?: Record<string, unknown>;
      createdAt?: string;
      label?: string;
      backendSessionId?: string;
    }>,
  ): void {
    saveRuntimeTopologySessions({
      sessions: sessions.map((session) => ({
        id: session.id,
        tool: session.command ?? "codex",
        toolConfigKey: session.command ?? "codex",
        command: session.command ?? "codex",
        args: [],
        lifecycle: session.status === "running" || session.status === "idle" ? "live" : "offline",
        createdAt: session.createdAt,
        backendSessionId: session.backendSessionId,
        team: session.team,
        label: session.label,
      })),
    });
  }

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

    const seenRes = await fetch(`${base}/threads/mark-seen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: opened.thread.id, session: "codex-1" }),
    });
    const seen = (await seenRes.json()) as { thread: { unreadBy?: string[] } };
    expect(seenRes.ok).toBe(true);
    expect(seen.thread.unreadBy ?? []).not.toContain("codex-1");

    const showRes = await fetch(`${base}/threads/${opened.thread.id}`);
    const detail = (await showRes.json()) as { thread: { id: string }; messages: Array<{ body: string }> };
    expect(showRes.ok).toBe(true);
    expect(detail.thread.id).toBe(opened.thread.id);
    expect(detail.messages.at(-1)?.body).toContain("parser error path");
  });

  it("lists agents with loop state and toggles the loop flag over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    seedAgentTopology([{ id: "codex-1", status: "running", team: { role: "coder" } }]);

    const beforeRes = await fetch(`${base}/agents`);
    const before = (await beforeRes.json()) as {
      ok: boolean;
      agents: Array<{ id: string; loop?: unknown; overseer?: boolean }>;
    };
    expect(beforeRes.ok).toBe(true);
    const seeded = before.agents.find((agent) => agent.id === "codex-1");
    expect(seeded).toBeTruthy();
    expect(seeded?.loop).toBeUndefined();
    expect(seeded?.overseer).toBe(false);

    const onRes = await fetch(`${base}/agents/loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", active: true, goal: "finish the parser" }),
    });
    const on = (await onRes.json()) as { ok: boolean; loop: { active: boolean; goal?: string } };
    expect(onRes.ok).toBe(true);
    expect(on.loop.active).toBe(true);
    expect(on.loop.goal).toBe("finish the parser");
    expect(loadMetadataState(repoRoot).sessions["codex-1"].loop?.goal).toBe("finish the parser");

    const afterRes = await fetch(`${base}/agents`);
    const after = (await afterRes.json()) as { agents: Array<{ id: string; loop?: { active: boolean } }> };
    expect(after.agents.find((agent) => agent.id === "codex-1")?.loop?.active).toBe(true);

    const offRes = await fetch(`${base}/agents/loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", active: false }),
    });
    expect(offRes.ok).toBe(true);
    expect(loadMetadataState(repoRoot).sessions["codex-1"].loop).toBeUndefined();

    const missingRes = await fetch(`${base}/agents/loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    expect(missingRes.status).toBe(400);

    // active must be an explicit boolean — omitting it must not silently clear the loop
    const noActiveRes = await fetch(`${base}/agents/loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1" }),
    });
    expect(noActiveRes.status).toBe(400);
  });

  it("marks offline agents without exact backend ids as blocked in the agents API", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    seedAgentTopology([
      { id: "codex-ready", command: "codex", status: "offline", backendSessionId: "backend-codex" },
      { id: "claude-blocked", command: "claude", status: "offline" },
    ]);

    const res = await fetch(`${base}/agents`);
    const body = (await res.json()) as {
      agents: Array<{ id: string; restoreState?: string; restoreBlockedReason?: string }>;
    };

    expect(res.ok).toBe(true);
    expect(body.agents.find((agent) => agent.id === "codex-ready")).toMatchObject({
      restoreState: "ready",
    });
    expect(body.agents.find((agent) => agent.id === "claude-blocked")).toMatchObject({
      restoreState: "blocked",
      restoreBlockedReason: "missing exact resumable backend session id",
    });
  });

  it("returns 400 for malformed encoded thread and task ids", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const threadRes = await fetch(`${base}/threads/%E0%A4%A`);
    expect(threadRes.status).toBe(400);

    const taskRes = await fetch(`${base}/tasks/%E0%A4%A`);
    expect(taskRes.status).toBe(400);
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

    const roleHandoffRes = await fetch(`${base}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        assignee: "reviewer",
        body: "Review this parser handoff.",
      }),
    });
    const roleHandoff = (await roleHandoffRes.json()) as {
      thread: { id: string; participants: string[] };
      message: { to?: string[] };
    };
    expect(roleHandoffRes.ok).toBe(true);
    expect(roleHandoff.thread.participants).toContain("reviewer");
    expect(roleHandoff.message.to).toEqual(["reviewer"]);

    upsertNotification({
      title: "Reviewer alert",
      body: "Notification feed alert",
      sessionId: "reviewer",
      kind: "needs_input",
    });

    const inboxRes = await fetch(`${base}/inbox?participant=reviewer`);
    const inbox = (await inboxRes.json()) as { inbox: Array<{ id: string; subjectId: string; title: string }> };
    expect(inboxRes.ok).toBe(true);
    expect(inbox.inbox).toEqual([expect.objectContaining({ subjectId: roleHandoff.thread.id })]);

    const inboxWithNotificationsRes = await fetch(`${base}/inbox?participant=reviewer&includeNotifications=1`);
    const inboxWithNotifications = (await inboxWithNotificationsRes.json()) as {
      inbox: Array<{ title: string; subjectId: string }>;
    };
    expect(inboxWithNotifications.inbox.map((entry) => entry.title)).toContain("Reviewer alert");

    const readInboxRes = await fetch(`${base}/inbox/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participant: "reviewer" }),
    });
    expect(readInboxRes.ok).toBe(true);
    const readInboxAgainRes = await fetch(`${base}/inbox?participant=reviewer&unread=1`);
    const readInboxAgain = (await readInboxAgainRes.json()) as { inbox: unknown[] };
    expect(readInboxAgain.inbox).toEqual([]);
    const notificationStillUnreadRes = await fetch(`${base}/notifications?sessionId=reviewer&unread=1`);
    const notificationStillUnread = (await notificationStillUnreadRes.json()) as { notifications: unknown[] };
    expect(notificationStillUnread.notifications).toHaveLength(1);

    const taskRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: ["codex-1"],
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

  it("passes agent interrupt over HTTP", async () => {
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        interruptAgent: ({ sessionId }) => ({ sessionId }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "claude-1" }),
    });
    const body = (await res.json()) as { ok: boolean; sessionId: string };
    expect(res.ok).toBe(true);
    expect(body).toEqual({ ok: true, sessionId: "claude-1" });
  });

  it("records backend session ids over HTTP so crashed panes stay resumable", async () => {
    server?.stop();
    const calls: Array<{ sessionId: string; backendSessionId: string }> = [];
    server = new MetadataServer({
      lifecycle: {
        recordBackendSessionId: (input) => {
          calls.push(input);
          return input;
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/record-backend-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "claude-1", backendSessionId: "0710a963" }),
    });
    const body = (await res.json()) as { ok: boolean; sessionId: string; backendSessionId: string };
    expect(res.ok).toBe(true);
    expect(body).toEqual({ ok: true, sessionId: "claude-1", backendSessionId: "0710a963" });
    expect(calls).toEqual([{ sessionId: "claude-1", backendSessionId: "0710a963" }]);
  });

  it("lists direct teammates from runtime topology instead of desktop pending overlays", async () => {
    server?.stop();
    seedAgentTopology([
      { id: "parent", command: "claude", status: "running" },
      {
        id: "late",
        command: "codex",
        status: "running",
        createdAt: "2026-01-01T00:00:02.000Z",
        team: { teamId: "team-parent", parentSessionId: "parent", role: "coder", order: 2 },
      },
      {
        id: "early",
        command: "claude",
        status: "running",
        createdAt: "2026-01-01T00:00:01.000Z",
        team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer", order: 1 },
      },
      {
        id: "nested",
        command: "codex",
        status: "running",
        team: { teamId: "team-nested", parentSessionId: "late", role: "coder" },
      },
      {
        id: "other",
        command: "codex",
        status: "running",
        team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder" },
      },
    ]);
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "parent", command: "claude", status: "running" }],
          teammates: [
            {
              id: "late",
              command: "codex",
              status: "running",
              createdAt: "2026-01-01T00:00:02.000Z",
              team: { teamId: "team-parent", parentSessionId: "parent", role: "coder", order: 2 },
            },
            {
              id: "early",
              command: "claude",
              status: "creating",
              pending: true,
              pendingAction: "creating",
              createdAt: "2026-01-01T00:00:01.000Z",
              team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer", order: 1 },
            },
            {
              id: "nested",
              command: "codex",
              status: "running",
              team: { teamId: "team-nested", parentSessionId: "late", role: "coder" },
            },
            {
              id: "other",
              command: "codex",
              status: "running",
              team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder" },
            },
          ],
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates?parentSessionId=parent`);
    const body = (await res.json()) as {
      ok: boolean;
      teammates: Array<{ id: string; sessionId: string; tool: string; role?: string; label?: string }>;
    };

    expect(res.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.teammates.map((session) => session.id)).toEqual(["early", "late"]);
    expect(body.teammates[0]).toMatchObject({
      id: "early",
      sessionId: "early",
      tool: "claude",
      role: "reviewer",
    });
  });

  it("preserves topology status values in teammate API records", async () => {
    server?.stop();
    seedAgentTopology([{ id: "parent", command: "claude", status: "running" }]);
    upsertTopologySession(
      {
        id: "idle-child",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
      },
      "idle",
    );
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "parent", command: "claude", status: "running" }],
          teammates: [],
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates?parentSessionId=parent`);
    const body = (await res.json()) as {
      ok: boolean;
      teammates: Array<{ id: string; status?: string }>;
    };

    expect(res.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.teammates).toEqual([expect.objectContaining({ id: "idle-child", status: "idle" })]);
  });

  it("opens notification targets from hidden teammate desktop state", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "parent", command: "claude", status: "running" }],
          teammates: [
            {
              id: "teammate-1",
              command: "codex",
              status: "running",
              tmuxWindowId: "@7",
              team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer" },
            },
          ],
          services: [],
        }),
      },
    });
    await server.start();

    const target = { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" } as any;
    const opened: any[] = [];
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const getTargetByWindowId = TmuxRuntimeManager.prototype.getTargetByWindowId;
    const getAttachedClientForTarget = TmuxRuntimeManager.prototype.getAttachedClientForTarget;
    const openTarget = TmuxRuntimeManager.prototype.openTarget;
    const refreshStatus = TmuxRuntimeManager.prototype.refreshStatus;
    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-test" }) as any;
    TmuxRuntimeManager.prototype.getTargetByWindowId = (_sessionName, windowId) =>
      windowId === "@7" ? target : undefined;
    TmuxRuntimeManager.prototype.getAttachedClientForTarget = () => undefined as any;
    TmuxRuntimeManager.prototype.openTarget = (nextTarget) => {
      opened.push(nextTarget);
    };
    TmuxRuntimeManager.prototype.refreshStatus = vi.fn();
    try {
      updateSessionMetadata("teammate-1", (current) => ({
        ...current,
        derived: {
          ...(current.derived ?? {}),
          activity: "waiting",
          attention: "needs_input",
          unseenCount: 2,
        },
      }));
      upsertNotification({
        title: "Needs input",
        body: "Agent needs input",
        sessionId: "teammate-1",
        kind: "needs_input",
      });

      const endpoint = server.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/open-notification-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "teammate-1" }),
      });

      expect(res.ok).toBe(true);
      expect(opened).toEqual([target]);
      expect(loadMetadataState().sessions["teammate-1"]?.derived).toMatchObject({
        attention: "normal",
        unseenCount: 0,
      });
      expect(listNotifications({ sessionId: "teammate-1" })[0]?.unread).toBe(false);
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.getTargetByWindowId = getTargetByWindowId;
      TmuxRuntimeManager.prototype.getAttachedClientForTarget = getAttachedClientForTarget;
      TmuxRuntimeManager.prototype.openTarget = openTarget;
      TmuxRuntimeManager.prototype.refreshStatus = refreshStatus;
    }
  });

  it("rejects teammate agents as parents for teammate discovery and delegation", async () => {
    server?.stop();
    seedAgentTopology([
      { id: "parent", command: "claude", status: "running" },
      {
        id: "child",
        command: "codex",
        status: "running",
        team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
      },
    ]);
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "parent", command: "claude", status: "running" }],
          teammates: [
            {
              id: "child",
              command: "codex",
              status: "running",
              team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
            },
          ],
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const listRes = await fetch(`${base}/agents/teammates?parentSessionId=child`);
    const listBody = (await listRes.json()) as { ok: boolean; error: string };
    expect(listRes.status).toBe(400);
    expect(listBody.error).toContain("nested teams");

    const taskRes = await fetch(`${base}/agents/teammates/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: "child", teammateSessionId: "grandchild", body: "hello" }),
    });
    const taskBody = (await taskRes.json()) as { ok: boolean; error: string };
    expect(taskRes.status).toBe(400);
    expect(taskBody.error).toContain("nested teams");
  });

  it("creates durable tasks for direct teammate work instead of raw input", async () => {
    server?.stop();
    seedAgentTopology([
      { id: "parent", command: "claude", status: "running" },
      {
        id: "child",
        command: "codex",
        status: "running",
        team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
      },
    ]);
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "parent", command: "claude", status: "running" }],
          teammates: [
            {
              id: "child",
              command: "codex",
              status: "running",
              team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
            },
          ],
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentSessionId: "parent",
        teammateSessionId: "child",
        title: "Review task",
        body: "Check this patch.",
      }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      parentSessionId: string;
      teammateSessionId: string;
      task: { id: string; assignedBy: string; assignedTo: string; description: string; prompt: string };
      thread?: { id: string; kind: string; waitingOn: string[] };
    };

    expect(res.ok).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      parentSessionId: "parent",
      teammateSessionId: "child",
      task: {
        assignedBy: "parent",
        assignedTo: "child",
        description: "Review task",
        prompt: "Check this patch.",
      },
    });
    expect(body.thread?.kind).toBe("task");
    expect(body.thread?.waitingOn).toEqual(["child"]);
    expect(readTask(body.task.id)?.prompt).toBe("Check this patch.");

    const promptOnlyRes = await fetch(`${base}/agents/teammates/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentSessionId: "parent",
        teammateSessionId: "child",
        body: "   ",
        prompt: "Investigate the prompt-only path.\nReport blockers first.",
      }),
    });
    const promptOnly = (await promptOnlyRes.json()) as {
      task: { description: string; prompt: string };
    };

    expect(promptOnlyRes.ok).toBe(true);
    expect(promptOnly.task.description).toBe("Investigate the prompt-only path.");
    expect(promptOnly.task.prompt).toBe("Investigate the prompt-only path.\nReport blockers first.");
  });

  it("retires raw teammate send in favor of durable task assignment", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: "parent", teammateSessionId: "child", body: "hello" }),
    });
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(410);
    expect(body.error).toContain("/agents/teammates/tasks");
  });

  it("rejects teammate tasks with an empty teammateSessionId", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: "parent", teammateSessionId: "   ", body: "hello" }),
    });
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("teammateSessionId");
  });

  it("rejects teammate tasks to non-direct teammates", async () => {
    server?.stop();
    seedAgentTopology([
      { id: "parent", command: "claude", status: "running" },
      { id: "ordinary", command: "codex", status: "running" },
      {
        id: "other-child",
        command: "codex",
        status: "running",
        team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder" },
      },
    ]);
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [
            { id: "parent", command: "claude", status: "running" },
            { id: "ordinary", command: "codex", status: "running" },
          ],
          teammates: [
            {
              id: "other-child",
              command: "codex",
              status: "running",
              team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder" },
            },
          ],
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: "parent", teammateSessionId: "ordinary", body: "hello" }),
    });
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(404);
    expect(body.error).toContain("not attached");
  });

  it("controls only direct teammate lifecycle targets", async () => {
    server?.stop();
    const calls: string[] = [];
    seedAgentTopology([
      { id: "parent", command: "claude", status: "running" },
      {
        id: "child",
        command: "codex",
        status: "offline",
        team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
      },
      {
        id: "other-child",
        command: "codex",
        status: "offline",
        team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder" },
      },
    ]);
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "parent", command: "claude", status: "running" }],
          teammates: [
            {
              id: "child",
              command: "codex",
              status: "offline",
              team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
            },
            {
              id: "other-child",
              command: "codex",
              status: "offline",
              team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder" },
            },
          ],
        }),
        resumeAgent: ({ sessionId }) => {
          calls.push(`resume:${sessionId}`);
          return { sessionId, status: "running" as const };
        },
      },
      lifecycle: {
        stopAgent: ({ sessionId }) => {
          calls.push(`stop:${sessionId}`);
          return { sessionId, status: "offline" as const };
        },
        killAgent: ({ sessionId }) => {
          calls.push(`kill:${sessionId}`);
          return { sessionId, status: "graveyard" as const, previousStatus: "offline" as const };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const request = (path: string, teammateSessionId = "child") =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentSessionId: "parent", teammateSessionId }),
      });

    expect((await (await request("/agents/teammates/stop")).json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      sessionId: "child",
      teammateSessionId: "child",
    });
    expect((await (await request("/agents/teammates/resume")).json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      sessionId: "child",
      teammateSessionId: "child",
    });
    expect((await (await request("/agents/teammates/kill")).json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      sessionId: "child",
      teammateSessionId: "child",
      status: "graveyard",
    });

    const foreign = await request("/agents/teammates/stop", "other-child");
    const foreignBody = (await foreign.json()) as { ok: boolean; error: string };
    expect(foreign.status).toBe(404);
    expect(foreignBody.error).toContain("not attached");
    expect(calls).toEqual(["stop:child", "resume:child", "kill:child"]);
  });

  it("resurrects direct graveyard teammates through graveyard-aware validation", async () => {
    server?.stop();
    const calls: string[] = [];
    seedAgentTopology([
      { id: "parent", command: "claude", status: "running" },
      {
        id: "child",
        command: "codex",
        status: "offline",
        team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
      },
      {
        id: "other-child",
        command: "codex",
        status: "offline",
        team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder" },
      },
    ]);
    moveTopologySessionToGraveyard("child");
    moveTopologySessionToGraveyard("other-child");
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "parent", command: "claude", status: "running" }],
          teammates: [],
        }),
        listGraveyard: () => [
          {
            id: "child",
            command: "codex",
            status: "graveyard",
            team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
          },
          {
            id: "other-child",
            command: "codex",
            status: "graveyard",
            team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder" },
          },
        ],
        resurrectGraveyard: ({ sessionId }) => {
          calls.push(`resurrect:${sessionId}`);
          return { sessionId, status: "offline" as const };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates/resurrect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: "parent", teammateSessionId: "child" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      parentSessionId: "parent",
      teammateSessionId: "child",
      sessionId: "child",
      status: "offline",
    });

    const foreign = await fetch(`${base}/agents/teammates/resurrect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: "parent", teammateSessionId: "other-child" }),
    });
    const foreignBody = (await foreign.json()) as { ok: boolean; error: string };
    expect(foreign.status).toBe(404);
    expect(foreignBody.error).toContain("not attached");
    expect(calls).toEqual(["resurrect:child"]);
  });

  it("passes graveyard resurrection over HTTP", async () => {
    server?.stop();
    const resurrectGraveyard = vi.fn(({ sessionId }) => ({ sessionId, status: "offline" as const }));
    server = new MetadataServer({
      desktop: { resurrectGraveyard },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/graveyard/resurrect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-old" }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, sessionId: "codex-old", status: "offline" });
    expect(resurrectGraveyard).toHaveBeenCalledWith({ sessionId: "codex-old" });
  });

  it("passes worktree graveyard resurrection and delete over HTTP", async () => {
    server?.stop();
    const resurrectGraveyardWorktree = vi.fn(({ path }) => ({ path, status: "active" as const }));
    const deleteGraveyardWorktree = vi.fn(({ path }) => ({ path, status: "removed" as const }));
    server = new MetadataServer({
      desktop: { resurrectGraveyardWorktree, deleteGraveyardWorktree },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const resurrectRes = await fetch(`${base}/graveyard/worktrees/resurrect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp/feature-a" }),
    });
    expect(resurrectRes.status).toBe(200);
    expect((await resurrectRes.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      path: "/tmp/feature-a",
      status: "active",
    });
    expect(resurrectGraveyardWorktree).toHaveBeenCalledWith({ path: "/tmp/feature-a" });

    const deleteRes = await fetch(`${base}/graveyard/worktrees/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp/feature-a" }),
    });
    expect(deleteRes.status).toBe(200);
    expect((await deleteRes.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      path: "/tmp/feature-a",
      status: "removed",
    });
    expect(deleteGraveyardWorktree).toHaveBeenCalledWith({ path: "/tmp/feature-a" });
  });

  it("passes graveyard cleanup over HTTP", async () => {
    server?.stop();
    const cleanupGraveyard = vi.fn(({ dryRun }) => ({
      dryRun,
      plan: {
        enabled: true,
        now: "2026-06-14T00:00:00.000Z",
        cutoff: "2026-05-31T00:00:00.000Z",
        retentionDays: 14,
        agents: [],
        worktrees: [],
      },
      results: [{ kind: "agent", id: "codex-old", status: "dry-run" }],
    }));
    server = new MetadataServer({
      desktop: { cleanupGraveyard },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/graveyard/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      dryRun: true,
      results: [{ kind: "agent", id: "codex-old", status: "dry-run" }],
    });
    expect(cleanupGraveyard).toHaveBeenCalledWith({ dryRun: true });
  });

  it("passes reused teammate creation responses over HTTP", async () => {
    server?.stop();
    const calls: unknown[] = [];
    server = new MetadataServer({
      lifecycle: {
        createTeammateAgent: (input) => {
          calls.push(input);
          return {
            sessionId: "reviewer-1",
            parentSessionId: input.parentSessionId,
            teamId: `team-${input.parentSessionId}`,
            role: input.role,
            label: input.label,
            reused: true,
          };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentSessionId: "parent",
        role: "reviewer",
        label: "reviewer",
        tool: "codex",
        sessionId: "codex-reviewer",
        worktreePath: "/tmp/review-worktree",
        extraArgs: ["--model", "gpt-5.5"],
        initialTask: {
          title: "Review the patch",
          body: "Review the patch and report blockers first.",
        },
        order: 2,
        open: true,
      }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      reused?: boolean;
      sessionId: string;
      task?: { id: string; assignedBy: string; assignedTo: string; description: string; prompt: string };
      thread?: { id: string; kind: string; waitingOn: string[] };
    };

    expect(res.ok).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      reused: true,
      sessionId: "reviewer-1",
      task: {
        assignedBy: "parent",
        assignedTo: "reviewer-1",
        description: "Review the patch",
        prompt: "Review the patch and report blockers first.",
      },
    });
    expect(body.thread?.kind).toBe("task");
    expect(body.thread?.waitingOn).toEqual(["reviewer-1"]);
    expect(body.task?.id ? readTask(body.task.id)?.prompt : undefined).toBe(
      "Review the patch and report blockers first.",
    );
    expect(calls).toEqual([
      {
        parentSessionId: "parent",
        role: "reviewer",
        label: "reviewer",
        tool: "codex",
        sessionId: "codex-reviewer",
        worktreePath: "/tmp/review-worktree",
        extraArgs: ["--model", "gpt-5.5"],
        order: 2,
        open: true,
      },
    ]);
  });

  it("rejects teammate creation when the requested parent is itself a teammate", async () => {
    server?.stop();
    const createTeammateAgent = vi.fn();
    seedAgentTopology([
      {
        id: "nested",
        command: "codex",
        status: "running",
        team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer" },
      },
    ]);
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [],
          teammates: [
            {
              id: "nested",
              command: "codex",
              status: "running",
              team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer" },
            },
          ],
        }),
      },
      lifecycle: { createTeammateAgent },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: "nested", role: "reviewer" }),
    });
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("nested teams");
    expect(createTeammateAgent).not.toHaveBeenCalled();
  });

  it("rejects empty initial teammate tasks before creating a teammate", async () => {
    server?.stop();
    const createTeammateAgent = vi.fn();
    seedAgentTopology([{ id: "parent", command: "claude", status: "running" }]);
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "parent", command: "claude", status: "running" }],
          teammates: [],
        }),
      },
      lifecycle: { createTeammateAgent },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/teammates/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: "parent", role: "coder", initialTask: { title: "Empty task" } }),
    });
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("initialTask");
    expect(createTeammateAgent).not.toHaveBeenCalled();
  });

  it("passes agent resume over HTTP", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        resumeAgent: ({ sessionId }) => ({ sessionId, status: "running" }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "claude-1" }),
    });
    const body = (await res.json()) as { ok: boolean; sessionId: string; status: string };
    expect(res.ok).toBe(true);
    expect(body).toEqual({ ok: true, sessionId: "claude-1", status: "running" });
  });

  it("persists the current live window as the preferred dashboard selection when reopening dashboard", async () => {
    const ensureProjectSession = TmuxRuntimeManager.prototype.ensureProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const ensureDashboardWindow = TmuxRuntimeManager.prototype.ensureDashboardWindow;
    const getWindowOption = TmuxRuntimeManager.prototype.getWindowOption;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const respawnWindow = TmuxRuntimeManager.prototype.respawnWindow;
    const setWindowOption = TmuxRuntimeManager.prototype.setWindowOption;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    const listClients = TmuxRuntimeManager.prototype.listClients;
    const getAttachedClientForTarget = TmuxRuntimeManager.prototype.getAttachedClientForTarget;
    const switchClientToTarget = TmuxRuntimeManager.prototype.switchClientToTarget;
    const refreshStatus = TmuxRuntimeManager.prototype.refreshStatus;
    const sendFocusIn = TmuxRuntimeManager.prototype.sendFocusIn;

    TmuxRuntimeManager.prototype.ensureProjectSession = () => ({ sessionName: "aimux-repo-abc" }) as any;
    TmuxRuntimeManager.prototype.hasSession = () => true;
    TmuxRuntimeManager.prototype.ensureDashboardWindow = () =>
      ({
        sessionName: "aimux-repo-abc-client-123",
        windowId: "@99",
        windowIndex: 0,
        windowName: "dashboard-123",
      }) as any;
    TmuxRuntimeManager.prototype.getWindowOption = () => "test-build";
    TmuxRuntimeManager.prototype.isWindowAlive = () => true;
    TmuxRuntimeManager.prototype.respawnWindow = () => undefined as any;
    TmuxRuntimeManager.prototype.setWindowOption = () => undefined as any;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@42", windowIndex: 4, windowName: "codex" },
          metadata: {
            kind: "agent",
            sessionId: "codex-1",
            worktreePath: "/repo/.aimux/worktrees/demo",
          },
        },
      ] as any;
    TmuxRuntimeManager.prototype.listClients = () =>
      [{ tty: "/dev/ttys001", sessionName: "aimux-repo-abc-client-123" }] as any;
    TmuxRuntimeManager.prototype.getAttachedClientForTarget = () => undefined as any;
    TmuxRuntimeManager.prototype.switchClientToTarget = () => undefined as any;
    TmuxRuntimeManager.prototype.refreshStatus = () => undefined as any;
    TmuxRuntimeManager.prototype.sendFocusIn = () => undefined as any;

    try {
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(
        `${base}/control/open-dashboard?currentClientSession=aimux-repo-abc-client-123&clientTty=%2Fdev%2Fttys001&currentWindowId=%4042`,
      );
      expect(res.ok).toBe(true);

      const snapshot = JSON.parse(
        readFileSync(getDashboardClientUiStatePath("aimux-repo-abc-client-123"), "utf-8"),
      ) as Record<string, unknown>;
      expect(snapshot).toMatchObject({
        screen: "dashboard",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        level: "sessions",
        selectedEntryKind: "session",
        selectedEntryId: "codex-1",
      });
    } finally {
      TmuxRuntimeManager.prototype.ensureProjectSession = ensureProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.ensureDashboardWindow = ensureDashboardWindow;
      TmuxRuntimeManager.prototype.getWindowOption = getWindowOption;
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.respawnWindow = respawnWindow;
      TmuxRuntimeManager.prototype.setWindowOption = setWindowOption;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
      TmuxRuntimeManager.prototype.listClients = listClients;
      TmuxRuntimeManager.prototype.getAttachedClientForTarget = getAttachedClientForTarget;
      TmuxRuntimeManager.prototype.switchClientToTarget = switchClientToTarget;
      TmuxRuntimeManager.prototype.refreshStatus = refreshStatus;
      TmuxRuntimeManager.prototype.sendFocusIn = sendFocusIn;
    }
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

    const listRes = await fetch(`${base}/tasks?session=codex-1&status=pending`);
    const list = (await listRes.json()) as { tasks: Array<{ id: string }> };
    expect(listRes.ok).toBe(true);
    expect(list.tasks.some((entry) => entry.id === task.task.id)).toBe(true);

    const showRes = await fetch(`${base}/tasks/${task.task.id}`);
    const show = (await showRes.json()) as { task: { id: string }; thread?: { id: string }; messages: unknown[] };
    expect(showRes.ok).toBe(true);
    expect(show.task.id).toBe(task.task.id);
    expect(show.thread?.id).toBeTruthy();
    expect(Array.isArray(show.messages)).toBe(true);

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

  it("reads agent output over HTTP", async () => {
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
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

  it("preserves mined parser blocks in agent output HTTP responses", async () => {
    const fixture = getParserFixture("codex-live-startup-suggestion-loop");
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        readAgentOutput: ({ sessionId, startLine }) => ({
          sessionId,
          startLine: startLine ?? -120,
          output: fixture.raw,
          parsed: parseAgentOutput(fixture.raw, { tool: fixture.tool }),
        }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const outputRes = await fetch(`${base}/agents/output?sessionId=codex-1&startLine=-160`);
    const outputJson = (await outputRes.json()) as {
      parsed: {
        blocks: Array<{ type: string; text: string }>;
      };
    };

    expect(outputRes.ok).toBe(true);
    expect(outputJson.parsed.blocks.map((block) => block.type)).toEqual(["meta", "status"]);
    expect(outputJson.parsed.blocks.some((block) => block.type === "prompt")).toBe(false);
    expect(outputJson.parsed.blocks[1]?.text).toContain("Explain this codebase");
    expect(outputJson.parsed.blocks[1]?.text).toContain("Starting MCP servers");
  });

  it("sends agent input over HTTP", async () => {
    const sent: Array<{ sessionId: string; text: string }> = [];
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        sendAgentInput: ({ sessionId, text }) => {
          sent.push({ sessionId, text });
          return { sessionId, accepted: true };
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
      body: JSON.stringify({ sessionId: "codex-1", text: "hello from gui" }),
    });
    const inputJson = (await inputRes.json()) as { ok: boolean; sessionId: string; accepted: boolean };

    expect(inputRes.ok).toBe(true);
    expect(inputJson).toMatchObject({ ok: true, sessionId: "codex-1", accepted: true });
    expect(sent).toEqual([{ sessionId: "codex-1", text: "hello from gui" }]);
  });

  it("rejects blank agent input over HTTP", async () => {
    const sent: Array<{ sessionId: string; text: string }> = [];
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        sendAgentInput: ({ sessionId, text }) => {
          sent.push({ sessionId, text });
          return { sessionId, accepted: true };
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
      body: JSON.stringify({ sessionId: "codex-1", text: "   \n\t  " }),
    });
    const inputJson = (await inputRes.json()) as { ok: boolean; error: string };

    expect(inputRes.status).toBe(400);
    expect(inputJson).toEqual({ ok: false, error: "text is required" });
    expect(sent).toEqual([]);
  });

  it("uploads image attachments and serves their content over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const imageBytes = Buffer.from("uploaded-image-bytes");

    const uploadRes = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "../shot.png",
        mimeType: "image/png",
        dataBase64: imageBytes.toString("base64"),
      }),
    });
    const uploaded = (await uploadRes.json()) as {
      ok: boolean;
      attachment: { id: string; filename: string; contentUrl: string; sizeBytes: number; source: string };
    };

    expect(uploadRes.ok).toBe(true);
    expect(uploaded.attachment.id).toMatch(/^att_/);
    expect(uploaded.attachment.filename).toBe("shot.png");
    expect(uploaded.attachment.sizeBytes).toBe(imageBytes.length);
    expect(uploaded.attachment.source).toBe("upload");

    const contentRes = await fetch(`${base}${uploaded.attachment.contentUrl}`);
    const contentBytes = Buffer.from(await contentRes.arrayBuffer());
    expect(contentRes.ok).toBe(true);
    expect(contentRes.headers.get("content-type")).toBe("image/png");
    expect(contentBytes.equals(imageBytes)).toBe(true);
  });

  it("rejects malformed uploaded image data", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const uploadRes = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "bad.png",
        mimeType: "image/png",
        dataBase64: "not-base64",
      }),
    });
    const uploaded = (await uploadRes.json()) as { ok: boolean; error: string };

    expect(uploadRes.status).toBe(400);
    expect(uploaded).toEqual({ ok: false, error: "attachment content must be base64" });
  });

  it("sends agent input with uploaded attachment file references", async () => {
    const sent: Array<{ sessionId: string; text: string }> = [];
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        sendAgentInput: ({ sessionId, text }) => {
          sent.push({ sessionId, text });
          return { sessionId, accepted: true };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const uploadRes = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "chart.webp",
        mimeType: "image/webp",
        dataBase64: Buffer.from("webp-bytes").toString("base64"),
      }),
    });
    const uploaded = (await uploadRes.json()) as { attachment: { id: string } };

    const inputRes = await fetch(`${base}/agents/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "codex-1",
        text: "please inspect",
        attachmentIds: [uploaded.attachment.id],
      }),
    });

    expect(inputRes.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("please inspect");
    expect(sent[0]!.text).toContain("Attached image files:");
    expect(sent[0]!.text).toContain("chart.webp (image/webp, 10 bytes):");
    expect(sent[0]!.text).toContain(join(repoRoot, ".aimux", "attachments", `${uploaded.attachment.id}.webp`));
  });

  it("accepts attachment-only agent input with a default prompt", async () => {
    const sent: Array<{ sessionId: string; text: string }> = [];
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        sendAgentInput: ({ sessionId, text }) => {
          sent.push({ sessionId, text });
          return { sessionId, accepted: true };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const uploadRes = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "chart.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("png-bytes").toString("base64"),
      }),
    });
    const uploaded = (await uploadRes.json()) as { attachment: { id: string } };

    const inputRes = await fetch(`${base}/agents/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", text: "", attachmentIds: [uploaded.attachment.id] }),
    });

    expect(inputRes.ok).toBe(true);
    expect(sent[0]!.text).toContain("Please review the attached image file(s).");
    expect(sent[0]!.text).toContain("chart.png");
  });

  it("rejects agent input with missing attachment ids", async () => {
    const sent: Array<{ sessionId: string; text: string }> = [];
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        sendAgentInput: ({ sessionId, text }) => {
          sent.push({ sessionId, text });
          return { sessionId, accepted: true };
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
      body: JSON.stringify({ sessionId: "codex-1", text: "inspect", attachmentIds: ["att_missing"] }),
    });
    const inputJson = (await inputRes.json()) as { ok: boolean; error: string };

    expect(inputRes.status).toBe(400);
    expect(inputJson).toEqual({ ok: false, error: "attachment not found: att_missing" });
    expect(sent).toEqual([]);
  });

  it("rejects agent input with unsafe attachment ids", async () => {
    const sent: Array<{ sessionId: string; text: string }> = [];
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        sendAgentInput: ({ sessionId, text }) => {
          sent.push({ sessionId, text });
          return { sessionId, accepted: true };
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
      body: JSON.stringify({ sessionId: "codex-1", text: "inspect", attachmentIds: ["../secrets"] }),
    });
    const inputJson = (await inputRes.json()) as { ok: boolean; error: string };

    expect(inputRes.status).toBe(400);
    expect(inputJson).toEqual({ ok: false, error: "attachment not found: ../secrets" });
    expect(sent).toEqual([]);
  });

  it("streams alert events over SSE", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("event: alert"));

    const attentionRes = await fetch(`${base}/set-attention`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: "codex-1",
        attention: "needs_input",
      }),
    });
    expect(attentionRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: ready");
    expect(text).toContain("event: alert");
    expect(text).toContain('"kind":"needs_input"');
    expect(text).toContain('"sessionId":"codex-1"');
  });

  it("updates shell service state over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const runningRes = await fetch(`${base}/shell-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: "running",
        sessionId: "shell-1",
        tool: "shell",
        command: "yarn devp",
      }),
    });
    expect(runningRes.ok).toBe(true);

    let derived = loadMetadataState(repoRoot).sessions["shell-1"]?.derived;
    expect(derived?.activity).toBe("running");
    expect(derived?.attention).toBe("normal");
    expect(derived?.unseenCount).toBe(0);
    expect(derived?.shellCommand).toBe("yarn devp");
    expect(derived?.shellCommandState).toBe("running");

    const promptRes = await fetch(`${base}/shell-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: "prompt",
        sessionId: "shell-1",
        tool: "shell",
      }),
    });
    expect(promptRes.ok).toBe(true);

    derived = loadMetadataState(repoRoot).sessions["shell-1"]?.derived;
    expect(derived?.activity).toBe("idle");
    expect(derived?.attention).toBe("normal");
    expect(derived?.shellCommand).toBe("yarn devp");
    expect(derived?.shellCommandState).toBe("prompt");
  });

  it("streams session chat events over SSE", async () => {
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

    const streamRes = await fetch(`${base}/events?sessionId=codex-1&startLine=-50&intervalMs=100`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("event: agent_output"));

    const text = await streamRead;
    expect(text).toContain("event: ready");
    expect(text).toContain("event: agent_output");
    expect(text).toContain('"sessionId":"codex-1"');
    expect(text).toContain('"output":"initial output"');
  });

  it("maps legacy notify calls onto the alert SSE stream", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes('"kind":"task_done"'));

    const notifyRes = await fetch(`${base}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "complete",
        title: "claude-1 finished",
        message: "Finished parser audit.",
      }),
    });
    expect(notifyRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: alert");
    expect(text).toContain('"kind":"task_done"');
    expect(text).toContain('"categoryLabel":"Done"');
    expect(text).toContain("Finished parser audit.");
  });

  it("emits message waiting alerts for thread sends", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events?sessionId=codex-1`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes('"kind":"message_waiting"'));

    const sendRes = await fetch(`${base}/threads/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: ["codex-1"],
        kind: "request",
        body: "Please inspect the timeout parser branch.",
        title: "Parser request",
      }),
    });
    expect(sendRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: alert");
    expect(text).toContain('"kind":"message_waiting"');
    expect(text).toContain('"sessionId":"codex-1"');
  });

  it("emits handoff waiting alerts for handoffs", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events?sessionId=codex-1`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes('"kind":"handoff_waiting"'));

    const handoffRes = await fetch(`${base}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: ["codex-1"],
        body: "Take over the timeout parser investigation.",
        title: "Parser handoff",
      }),
    });
    expect(handoffRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: alert");
    expect(text).toContain('"kind":"handoff_waiting"');
    expect(text).toContain('"sessionId":"codex-1"');
  });

  it("emits review waiting alerts for assigned reviews", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events?sessionId=codex-1`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes('"kind":"review_waiting"'));

    const reviewRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Review the timeout parser patch",
        type: "review",
      }),
    });
    expect(reviewRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: alert");
    expect(text).toContain('"kind":"review_waiting"');
    expect(text).toContain('"sessionId":"codex-1"');
  });

  it("emits task assigned alerts for assigned tasks", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events?sessionId=codex-1`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes('"kind":"task_assigned"'));

    const taskRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Audit the timeout parser branch",
        type: "task",
      }),
    });
    expect(taskRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: alert");
    expect(text).toContain('"kind":"task_assigned"');
    expect(text).toContain('"sessionId":"codex-1"');
  });

  it("does not emit generic message alerts for status messages", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events?sessionId=codex-1`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const sendRes = await fetch(`${base}/threads/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: ["codex-1"],
        kind: "status",
        body: "Status update only.",
        title: "Status",
      }),
    });
    expect(sendRes.ok).toBe(true);

    const text = await readSseUntil(streamRes.body!, (value) => value.includes(": keepalive") || value.length > 128);
    expect(text).not.toContain('"kind":"message_waiting"');
  });

  it("emits review approval alerts to the original assigner", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const assignRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Review the timeout parser patch",
        type: "review",
      }),
    });
    const assigned = (await assignRes.json()) as { task: { id: string } };
    expect(assignRes.ok).toBe(true);

    const streamRes = await fetch(`${base}/events?sessionId=claude-lead`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("Review approved:"));

    const approveRes = await fetch(`${base}/reviews/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: assigned.task.id,
        from: "codex-1",
        body: "Looks good.",
      }),
    });
    expect(approveRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain('"kind":"task_done"');
    expect(text).toContain('"sessionId":"claude-lead"');
  });

  it("emits review changes-requested alerts to the original assigner", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const assignRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Review the timeout parser follow-up",
        type: "review",
      }),
    });
    const assigned = (await assignRes.json()) as { task: { id: string } };
    expect(assignRes.ok).toBe(true);

    const streamRes = await fetch(`${base}/events?sessionId=claude-lead`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("Changes requested:"));

    const changesRes = await fetch(`${base}/reviews/request-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: assigned.task.id,
        from: "codex-1",
        body: "Please tighten the tests.",
      }),
    });
    expect(changesRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain('"kind":"blocked"');
    expect(text).toContain('"sessionId":"claude-lead"');
  });

  it("serves existing attachment metadata plus content over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const attachmentsDir = join(repoRoot, ".aimux", "attachments");
    const attachmentId = "att_existing";
    const imagePath = join(attachmentsDir, `${attachmentId}.png`);
    const imageBytes = Buffer.from("fake-image-bytes");
    writeFileSync(imagePath, imageBytes);
    writeFileSync(
      join(attachmentsDir, `${attachmentId}.json`),
      `${JSON.stringify(
        {
          id: attachmentId,
          kind: "image",
          filename: "shot.png",
          mimeType: "image/png",
          sizeBytes: imageBytes.length,
          sha256: "test-sha",
          createdAt: "2025-01-01T00:00:00.000Z",
          source: "path",
          contentPath: imagePath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const showRes = await fetch(`${base}/attachments/${attachmentId}`);
    const shown = (await showRes.json()) as { ok: boolean; attachment: { id: string; contentUrl: string } };
    expect(showRes.ok).toBe(true);
    expect(shown.attachment.id).toBe(attachmentId);
    expect(shown.attachment.contentUrl).toBe(`/attachments/${attachmentId}/content`);

    const contentRes = await fetch(`${base}${shown.attachment.contentUrl}`);
    const contentBytes = Buffer.from(await contentRes.arrayBuffer());
    expect(contentRes.ok).toBe(true);
    expect(contentRes.headers.get("content-type")).toBe("image/png");
    expect(contentBytes.equals(imageBytes)).toBe(true);
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

  it("rejects legacy agent history over HTTP", async () => {
    server?.stop();
    server = new MetadataServer({});
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const historyRes = await fetch(`${base}/agents/history?sessionId=claude-1&lastN=5`);
    const historyJson = (await historyRes.json()) as { ok: boolean; error: string };
    expect(historyRes.status).toBe(410);
    expect(historyJson).toEqual({
      ok: false,
      error: "agent message history requires the runtime core replacement",
    });
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

  it("preserves mined parser blocks in agent output SSE events", async () => {
    const fixture = getParserFixture("claude-live-tool-action-rows");
    server?.stop();
    let reads = 0;
    server = new MetadataServer({
      lifecycle: {
        readAgentOutput: ({ sessionId, startLine }) => {
          reads += 1;
          return {
            sessionId,
            startLine: startLine ?? -120,
            output: reads >= 2 ? fixture.raw : "initial output",
            parsed:
              reads >= 2
                ? parseAgentOutput(fixture.raw, { tool: fixture.tool })
                : {
                    blocks: [{ type: "response" as const, text: "initial output" }],
                    parser: {
                      tool: "claude",
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

    const res = await fetch(`${base}/agents/output/stream?sessionId=claude-1&startLine=-160&intervalMs=100`, {
      signal: controller.signal,
    });

    expect(res.ok).toBe(true);
    expect(res.body).toBeTruthy();
    const text = await readSseUntil(res.body!, (value) => value.includes("All checks are green"));
    controller.abort();

    expect(text).toContain(
      '"parsed":{"blocks":[{"type":"response","text":"Good question. Let me check the relay status."}',
    );
    expect(text).toContain('{"type":"status","text":"⏺ Bash(cd /workspace/project; gh pr checks 5968)');
    expect(text).toContain('{"type":"response","text":"All checks are green. I can merge now."}');
  });

  it("lists and clears notifications over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const notifyRes = await fetch(`${base}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Claude Code",
        subtitle: "Waiting",
        message: "Agent needs input",
        sessionId: "claude-1",
        kind: "needs_input",
      }),
    });
    expect(notifyRes.ok).toBe(true);

    const listRes = await fetch(`${base}/notifications`);
    const listed = (await listRes.json()) as {
      ok: boolean;
      unreadCount: number;
      notifications: Array<{
        sessionId?: string;
        title: string;
        body: string;
        categoryLabel?: string;
        reasonLabel?: string;
      }>;
    };
    expect(listRes.ok).toBe(true);
    expect(listed.ok).toBe(true);
    expect(listed.unreadCount).toBe(1);
    expect(listed.notifications[0]).toMatchObject({
      sessionId: "claude-1",
      title: expect.stringContaining("[Needs input]"),
      body: "Agent is waiting for input: claude-1 needs input - Waiting — Agent needs input",
      categoryLabel: "Needs input",
      reasonLabel: "Agent is waiting for input",
    });

    const clearRes = await fetch(`${base}/notifications/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "claude-1" }),
    });
    const cleared = (await clearRes.json()) as { ok: boolean; cleared: number };
    expect(clearRes.ok).toBe(true);
    expect(cleared).toEqual({ ok: true, cleared: 1 });

    const unreadRes = await fetch(`${base}/notifications?unread=1`);
    const unreadJson = (await unreadRes.json()) as { unreadCount: number; notifications: unknown[] };
    expect(unreadJson.unreadCount).toBe(0);
    expect(unreadJson.notifications).toHaveLength(0);
  });

  it("uses dashboard display context in session notification titles", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getSessionDisplayContext: (sessionId) =>
          sessionId === "claude-hb01nv"
            ? {
                label: "bugs",
                command: "claude",
                worktreeName: "Main Checkout",
                branch: "master",
              }
            : undefined,
      },
    });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const notifyRes = await fetch(`${base}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Claude Code",
        message: "Claude is waiting for your input",
        sessionId: "claude-hb01nv",
        kind: "needs_input",
      }),
    });
    expect(notifyRes.ok).toBe(true);

    const listRes = await fetch(`${base}/notifications`);
    const listed = (await listRes.json()) as {
      ok: boolean;
      notifications: Array<{
        sessionId?: string;
        title: string;
        body: string;
        worktreeName?: string;
        categoryLabel?: string;
        reasonLabel?: string;
      }>;
    };
    expect(listRes.ok).toBe(true);
    expect(listed.notifications[0]).toMatchObject({
      sessionId: "claude-hb01nv",
      title: expect.stringContaining("[Needs input]"),
      body: "Agent is waiting for input: bugs @ Main Checkout needs input - Claude is waiting for your input",
      worktreeName: "Main Checkout",
      categoryLabel: "Needs input",
      reasonLabel: "Agent is waiting for input",
    });
  });

  it("uses dashboard display context in service completion notifications", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getSessionDisplayContext: (sessionId) =>
          sessionId === "service-1"
            ? {
                label: "shell",
                command: "shell",
                worktreeName: "Main Checkout",
                branch: "master",
              }
            : undefined,
      },
    });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const runningRes = await fetch(`${base}/shell-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "service-1", tool: "service", state: "running" }),
    });
    expect(runningRes.ok).toBe(true);

    const promptRes = await fetch(`${base}/shell-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "service-1", tool: "service", state: "prompt" }),
    });
    expect(promptRes.ok).toBe(true);

    const listRes = await fetch(`${base}/notifications`);
    const listed = (await listRes.json()) as {
      ok: boolean;
      notifications: Array<{
        sessionId?: string;
        title: string;
        body: string;
        worktreeName?: string;
        categoryLabel?: string;
        reasonLabel?: string;
      }>;
    };
    expect(listRes.ok).toBe(true);
    expect(listed.notifications[0]).toMatchObject({
      sessionId: "service-1",
      title: expect.stringContaining("[Done]"),
      body: "Agent or service finished: shell @ Main Checkout finished - Shell returned to a prompt.",
      worktreeName: "Main Checkout",
      categoryLabel: "Done",
      reasonLabel: "Agent or service finished",
    });
  });

  it("routes agent rename through lifecycle without writing metadata labels", async () => {
    server?.stop();
    const renameAgent = vi.fn(async ({ sessionId, label }: { sessionId: string; label?: string }) => ({
      sessionId,
      label: label?.trim() || undefined,
    }));
    server = new MetadataServer({
      lifecycle: {
        renameAgent,
      },
    });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/agents/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", label: "  review  " }),
    });

    expect(res.ok).toBe(true);
    expect(renameAgent).toHaveBeenCalledWith({ sessionId: "codex-1", label: "  review  " });
    expect(loadMetadataState(repoRoot).sessions["codex-1"]).toBeUndefined();
  });
});

describe("MetadataServer plan endpoints", () => {
  let repoRoot = "";
  let server: MetadataServer | null = null;
  let base = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-server-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    server = new MetadataServer();
    await server.start();
    const endpoint = server.getAddress();
    base = `http://${endpoint!.host}:${endpoint!.port}`;
  });

  afterEach(() => {
    server?.stop();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("returns 404 when plan file is missing", async () => {
    const res = await fetch(`${base}/plans/missing-session`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Plan not found");
  });

  it("PUT then GET roundtrip returns same content", async () => {
    const putRes = await fetch(`${base}/plans/session-a`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Plan A\n\nFirst draft." }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { ok: boolean; sessionId: string };
    expect(putBody.ok).toBe(true);
    expect(putBody.sessionId).toBe("session-a");

    const getRes = await fetch(`${base}/plans/session-a`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      ok: boolean;
      sessionId: string;
      content: string;
    };
    expect(getBody.ok).toBe(true);
    expect(getBody.sessionId).toBe("session-a");
    expect(getBody.content).toBe("# Plan A\n\nFirst draft.");
  });

  it("second PUT overwrites first", async () => {
    const first = await fetch(`${base}/plans/session-b`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "first" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${base}/plans/session-b`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "second" }),
    });
    expect(second.status).toBe(200);

    const getRes = await fetch(`${base}/plans/session-b`);
    const body = (await getRes.json()) as { content: string };
    expect(body.content).toBe("second");
  });

  it("PUT empty string content is allowed", async () => {
    const putRes = await fetch(`${base}/plans/session-c`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${base}/plans/session-c`);
    const body = (await getRes.json()) as { content: string };
    expect(body.content).toBe("");
  });

  it("PUT rejects non-string content with 400", async () => {
    const res = await fetch(`${base}/plans/session-d`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: 42 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("content must be a string");
  });

  it("PUT rejects missing content field with 400", async () => {
    const res = await fetch(`${base}/plans/session-e`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("content must be a string");
  });

  it("rejects invalid sessionId variants on GET and PUT", async () => {
    // Note: a literal ".." sessionId is unreachable — both `fetch` and the WHATWG URL
    // parser used by the server normalize `/plans/..` (or `/plans/%2E%2E`) to `/`.
    // The `..`-substring check in validateSessionId is defense-in-depth for cases
    // like `f..oo` that survive URL parsing but still indicate path traversal intent.
    // We percent-encode each char so slashes don't get collapsed before reaching the server.
    const percentEncode = (s: string) =>
      Array.from(s)
        .map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
    const invalid = ["f..oo", "foo/bar", "foo\\bar"];
    for (const raw of invalid) {
      const encoded = percentEncode(raw);
      const getRes = await fetch(`${base}/plans/${encoded}`);
      expect(getRes.status, `GET /plans/${raw}`).toBe(400);
      const getBody = (await getRes.json()) as { ok: boolean; error: string };
      expect(getBody.ok).toBe(false);
      expect(getBody.error).toBe("invalid sessionId");

      const putRes = await fetch(`${base}/plans/${encoded}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      expect(putRes.status, `PUT /plans/${raw}`).toBe(400);
      const putBody = (await putRes.json()) as { ok: boolean; error: string };
      expect(putBody.ok).toBe(false);
      expect(putBody.error).toBe("invalid sessionId");
    }
  });

  it("PUT creates parent dir when missing", async () => {
    rmSync(getPlansDir(), { recursive: true, force: true });

    const putRes = await fetch(`${base}/plans/session-f`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { ok: boolean; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe("session-f");
    expect(readFileSync(join(getPlansDir(), "session-f.md"), "utf8")).toBe("hello");
  });
});
