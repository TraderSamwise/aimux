import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getDashboardClientUiStatePath, getPlansDir, getProjectStateDir, initPaths } from "./paths.js";
import { MetadataServer } from "./metadata-server.js";
import { PROJECT_API_ROUTES } from "./project-api-contract.js";
import { loadMetadataState, updateSessionMetadata } from "./metadata-store.js";
import { loadNotificationContexts } from "./notification-context.js";
import { listNotifications, upsertNotification } from "./notifications.js";
import { addDashboardOperationFailure, listDashboardOperationFailures } from "./dashboard/operation-failures.js";
import { getDashboardCommandSpec } from "./dashboard/command-spec.js";
import { readTask } from "./tasks.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import { parseAgentOutput } from "./agent-output-parser.js";
import { getParserFixture } from "./agent-output-parser-test-utils.js";
import {
  moveTopologySessionToGraveyard,
  saveRuntimeTopologySessions,
  upsertTopologySession,
} from "./runtime-core/topology-sessions.js";
import {
  getRuntimeOwnerId,
  TMUX_DASHBOARD_OWNER_OPTION,
  TMUX_DASHBOARD_READY_OPTION,
  TMUX_RUNTIME_OWNER_OPTION,
} from "./runtime-owner.js";
import { loadLastUsedState } from "./last-used.js";

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

  it("keeps project service health cheap", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();

    const response = await fetch(`http://127.0.0.1:${endpoint!.port}/health`);
    const json = await response.json();

    expect(json).toMatchObject({
      ok: true,
      pid: process.pid,
      serviceInfo: expect.any(Object),
    });
    expect(json.resources).toBeUndefined();
    expect(json.recentSlowRequests).toBeUndefined();
    expect(json.plugins).toBeUndefined();
  });

  it("exposes project service resource diagnostics separately from health", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();

    const response = await fetch(`http://127.0.0.1:${endpoint!.port}/diagnostics`);
    const json = await response.json();

    expect(json).toMatchObject({
      ok: true,
      pid: process.pid,
      resources: {
        uptimeMs: expect.any(Number),
        memoryRssBytes: expect.any(Number),
        memoryHeapUsedBytes: expect.any(Number),
      },
      recentSlowRequests: [],
    });
  });

  it("allows private-network browser preflight requests", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();

    const response = await fetch(`http://127.0.0.1:${endpoint!.port}/live-pane/input`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8085",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:8085");
    expect(response.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("rejects private-network preflight requests from untrusted origins", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();

    const response = await fetch(`http://127.0.0.1:${endpoint!.port}/live-pane/input`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true",
      },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-private-network")).toBeNull();
  });

  it("tolerates missing runtime context payloads", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const baseUrl = `http://127.0.0.1:${endpoint!.port}`;
    updateSessionMetadata("claude-1", (current) => ({
      ...current,
      context: { cwd: "/repo", pr: { number: 42, title: "Ship it" } },
    }));

    const response = await fetch(`${baseUrl}${PROJECT_API_ROUTES.runtime.setContext}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "claude-1", context: null }),
    });

    expect(response.ok).toBe(true);
    expect(loadMetadataState().sessions["claude-1"].context).toEqual({
      cwd: "/repo",
      pr: { number: 42, title: "Ship it" },
    });
  });

  it("serves team config reads and mutations from the project service", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const baseUrl = `http://127.0.0.1:${endpoint!.port}`;

    const initial = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.config}`).then((res) => res.json());
    expect(initial).toMatchObject({
      ok: true,
      config: {
        defaultRole: "coder",
        roles: {
          coder: { description: expect.any(String), reviewedBy: "reviewer" },
        },
      },
    });

    const add = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.addRole}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "planner",
        description: "Plans work",
        reviewedBy: "reviewer",
        canEdit: true,
      }),
    }).then((res) => res.json());
    expect(add).toMatchObject({
      ok: true,
      role: "planner",
      config: {
        roles: {
          planner: { description: "Plans work", reviewedBy: "reviewer", canEdit: true },
        },
      },
    });

    const stored = JSON.parse(readFileSync(join(repoRoot, ".aimux", "team.json"), "utf8"));
    expect(stored.roles.planner).toEqual({ description: "Plans work", reviewedBy: "reviewer", canEdit: true });

    const updated = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.addRole}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "planner",
        description: "Plans revised",
      }),
    }).then((res) => res.json());
    expect(updated.config.roles.planner).toEqual({
      description: "Plans revised",
      reviewedBy: "reviewer",
      canEdit: true,
    });

    const defaulted = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.defaultRole}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "planner" }),
    }).then((res) => res.json());
    expect(defaulted.config.defaultRole).toBe("planner");

    const missingDefault = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.defaultRole}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "missing" }),
    });
    expect(missingDefault.status).toBe(404);
    await expect(missingDefault.json()).resolves.toMatchObject({
      ok: false,
      error: 'Role "missing" not found. Add it first with: aimux team add missing',
    });

    const removed = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.removeRole}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "planner" }),
    }).then((res) => res.json());
    expect(removed.config.roles.planner).toBeUndefined();
    expect(removed.config.defaultRole).toBe("coder");

    const initialized = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.init}`, {
      method: "POST",
    }).then((res) => res.json());
    expect(initialized).toMatchObject({
      ok: true,
      config: { defaultRole: "coder", roles: { coder: expect.any(Object), reviewer: expect.any(Object) } },
    });

    const reviewerRemoved = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.removeRole}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    }).then((res) => res.json());
    expect(reviewerRemoved.config.defaultRole).toBe("coder");

    const lastRoleRemoved = await fetch(`${baseUrl}${PROJECT_API_ROUTES.team.removeRole}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "coder" }),
    });
    expect(lastRoleRemoved.status).toBe(400);
    await expect(lastRoleRemoved.json()).resolves.toMatchObject({
      ok: false,
      error: "cannot remove the last team role",
    });
  });

  it("records slow desktop-state requests for health diagnostics", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getState: () => {
          const deadline = Date.now() + 275;
          while (Date.now() < deadline) {
            Date.now();
          }
          return {
            sessions: [],
            teammates: [],
            services: [],
            worktreeGroups: [],
            mainCheckoutInfo: { name: "Main Checkout" },
          };
        },
      },
    });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();

    await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`);
    const health = await fetch(`http://127.0.0.1:${endpoint!.port}/diagnostics`);
    const json = await health.json();

    expect(json.recentSlowRequests).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/desktop-state",
        statusCode: 200,
        durationMs: expect.any(Number),
        resources: expect.objectContaining({
          memoryRssBytes: expect.any(Number),
          memoryHeapUsedBytes: expect.any(Number),
        }),
      }),
    ]);
  });

  it("returns a terminal worktree create error for synchronous desktop failures", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        failureMessage: "branch already exists",
        getState: () => ({ sessions: [] }),
        createWorktree(this: { failureMessage: string }) {
          throw new Error(this.failureMessage);
        },
      } as any,
    });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();

    const response = await fetch(`http://127.0.0.1:${endpoint!.port}${PROJECT_API_ROUTES.worktreeActions.create}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    const json = await response.json();

    expect(response.status).toBe(422);
    expect(json).toMatchObject({ ok: false, error: "branch already exists" });
  });

  it("does not record long-lived stream routes as slow requests", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://127.0.0.1:${endpoint!.port}`;
    const controller = new AbortController();

    const stream = await fetch(`${base}/agents/interaction/stream`, { signal: controller.signal });
    expect(stream.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await stream.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const health = await fetch(`${base}/diagnostics`);
    const json = await health.json();
    expect(json.recentSlowRequests).toEqual([]);
  });

  it("marks usage through the project service and notifies clients", async () => {
    server?.stop();
    const onChange = vi.fn();
    server = new MetadataServer({ onChange });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/usage/mark`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        itemId: "service-1",
        clientSession: "aimux-client-1",
        usedAt: "2026-06-28T04:00:00.000Z",
      }),
    });
    const body = (await res.json()) as { ok: boolean; itemId: string; lastUsedAt: string | null };

    expect(res.ok).toBe(true);
    expect(body).toMatchObject({ ok: true, itemId: "service-1", lastUsedAt: "2026-06-28T04:00:00.000Z" });
    expect(loadLastUsedState(repoRoot).clients["aimux-client-1"]?.recentIds[0]).toBe("service-1");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps out-of-order usage marks monotonic", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const markUsage = (itemId: string, usedAt: string) =>
      fetch(`${base}/usage/mark`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, clientSession: "aimux-client-1", usedAt }),
      });

    await markUsage("agent-b", "2026-06-28T04:00:02.000Z");
    await markUsage("agent-a", "2026-06-28T04:00:01.000Z");

    const state = loadLastUsedState(repoRoot);
    expect(state.projectRecentIds.slice(0, 2)).toEqual(["agent-b", "agent-a"]);
    expect(state.clients["aimux-client-1"]?.recentIds.slice(0, 2)).toEqual(["agent-b", "agent-a"]);
  });

  it("exposes plugin startup diagnostics in health", async () => {
    server?.stop();
    server = new MetadataServer({
      diagnostics: {
        pluginStatuses: () => [
          {
            source: "user",
            name: "file-watch-plugin",
            path: "/tmp/file-watch-plugin.js",
            status: "failed",
            error: "EMFILE: too many open files, watch",
            resourceFailure: true,
            stoppedAfterFailedStart: true,
          },
        ],
      },
    });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();

    const health = await fetch(`http://127.0.0.1:${endpoint!.port}/diagnostics`);
    const json = await health.json();

    expect(json.plugins).toEqual([
      expect.objectContaining({
        name: "file-watch-plugin",
        status: "failed",
        resourceFailure: true,
      }),
    ]);
  });

  it("caches desktop-state reads and refreshes dirty snapshots off the request path", async () => {
    const getState = vi.fn(() => ({
      sessions: [],
      teammates: [],
      services: [],
      worktreeGroups: [],
      mainCheckoutInfo: { name: "Main Checkout" },
      seq: getState.mock.calls.length,
    }));
    server?.stop();
    server = new MetadataServer({ desktop: { getState } });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();

    const first = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    const second = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(1);
    expect(getState).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const cached = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    expect(cached.seq).toBe(1);
    expect(getState).toHaveBeenCalledTimes(1);

    server.notifyChange();
    const third = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    expect(third.seq).toBe(1);
    expect(getState).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const refreshed = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) =>
      response.json(),
    );
    expect(refreshed.seq).toBe(2);
  });

  it("refreshes force desktop-state reads synchronously after project changes", async () => {
    const getState = vi.fn(() => ({
      sessions: [],
      teammates: [],
      services: [],
      worktreeGroups: [],
      mainCheckoutInfo: { name: "Main Checkout" },
      seq: getState.mock.calls.length,
    }));
    server?.stop();
    server = new MetadataServer({ desktop: { getState } });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();

    const first = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    expect(first.seq).toBe(1);

    server.notifyChange();
    const stale = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    expect(stale.seq).toBe(1);

    const forced = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state?force=1`).then((response) =>
      response.json(),
    );
    expect(forced.seq).toBe(2);
    expect(getState).toHaveBeenCalledTimes(2);

    const refreshed = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) =>
      response.json(),
    );
    expect(refreshed.seq).toBe(2);
  });

  it("serves expired desktop-state cache immediately and refreshes off the request path", async () => {
    const getState = vi.fn(() => ({
      sessions: [],
      teammates: [],
      services: [],
      worktreeGroups: [],
      mainCheckoutInfo: { name: "Main Checkout" },
      seq: getState.mock.calls.length,
    }));
    server?.stop();
    server = new MetadataServer({ desktop: { getState } });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();

    const first = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    expect(first.seq).toBe(1);
    (server as any).desktopStateCache.ts = Date.now() - 11_000;

    const stale = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    expect(stale.seq).toBe(1);

    await vi.waitFor(() => expect(getState.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
  });

  it("refreshes desktop-state cache when alerts publish project updates", async () => {
    const getState = vi.fn(() => ({
      sessions: [],
      teammates: [],
      services: [],
      worktreeGroups: [],
      mainCheckoutInfo: { name: "Main Checkout" },
      seq: getState.mock.calls.length,
    }));
    server?.stop();
    server = new MetadataServer({ desktop: { getState } });
    await server.start();
    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();

    const first = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());
    expect(first.seq).toBe(1);
    server.getEventBus().publishAlert({
      kind: "needs_input",
      title: "Needs input",
      message: "Agent needs input",
      sessionId: "agent-1",
      cooldownMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await fetch(`http://127.0.0.1:${endpoint!.port}/desktop-state`).then((response) => response.json());

    expect(second.seq).toBe(2);
    expect(getState).toHaveBeenCalledTimes(2);
  });

  function seedAgentTopology(
    sessions: Array<{
      id: string;
      command?: string;
      status?: "starting" | "running" | "idle" | "offline";
      team?: Record<string, unknown>;
      createdAt?: string;
      label?: string;
      backendSessionId?: string;
    }>,
  ): void {
    const starting = sessions.filter((session) => session.status === "starting");
    const stable = sessions.filter((session) => session.status !== "starting");
    saveRuntimeTopologySessions({
      sessions: stable.map((session) => ({
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
    for (const session of starting) {
      upsertTopologySession(
        {
          id: session.id,
          tool: session.command ?? "codex",
          toolConfigKey: session.command ?? "codex",
          command: session.command ?? "codex",
          args: [],
          lifecycle: "live",
          createdAt: session.createdAt,
          backendSessionId: session.backendSessionId,
          team: session.team,
          label: session.label,
        },
        "starting",
      );
    }
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

    const routedRes = await fetch(`${base}/threads/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "user",
        assignee: "codex-1",
        kind: "request",
        body: "Please inspect the routed message path.",
      }),
    });
    const routed = (await routedRes.json()) as { message: { to?: string[] } };
    expect(routedRes.ok).toBe(true);
    expect(routed.message.to).toEqual(["codex-1"]);
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

  it("lists starting agents over HTTP", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    seedAgentTopology([{ id: "codex-starting", status: "starting", team: { role: "coder" } }]);

    const res = await fetch(`${base}/agents`);
    const body = (await res.json()) as {
      agents: Array<{ id: string; status?: string; role?: string }>;
    };

    expect(res.ok).toBe(true);
    expect(body.agents.find((agent) => agent.id === "codex-starting")).toMatchObject({
      id: "codex-starting",
      status: "starting",
      role: "coder",
    });
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

    const notificationStillUnreadRes = await fetch(`${base}/notifications?sessionId=reviewer&unread=1`);
    const notificationStillUnread = (await notificationStillUnreadRes.json()) as {
      notifications: Array<{ title: string }>;
    };
    expect(notificationStillUnread.notifications).toHaveLength(1);
    expect(notificationStillUnread.notifications[0]?.title).toBe("Reviewer alert");

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
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      sessionId: "claude-1",
      transition: { operation: "agent.interrupt", targetKind: "agent", targetId: "claude-1" },
    });
  });

  it("drives live pane control endpoints over HTTP", async () => {
    const calls: Array<{ kind: string; sessionId: string; cols?: number; rows?: number; text?: string }> = [];
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        readAgentOutput: ({ sessionId, startLine }) => ({
          sessionId,
          startLine: startLine ?? -120,
          output: `output for ${sessionId}`,
          parsed: { blocks: [{ type: "response", text: `output for ${sessionId}` }] },
        }),
        sendAgentInput: ({ sessionId, text }) => {
          calls.push({ kind: "input", sessionId, text });
          return { sessionId, accepted: true };
        },
        interruptAgent: ({ sessionId }) => {
          calls.push({ kind: "interrupt", sessionId });
          return { sessionId };
        },
        resizeAgentPane: ({ sessionId, cols, rows }) => {
          calls.push({ kind: "resize", sessionId, cols, rows });
          return { sessionId, cols, rows };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const outputRes = await fetch(`${base}/live-pane/output?sessionId=codex-1&startLine=-80`);
    const output = (await outputRes.json()) as { ok: boolean; sessionId: string; startLine: number; output: string };
    expect(outputRes.ok).toBe(true);
    expect(output).toMatchObject({ ok: true, sessionId: "codex-1", startLine: -80, output: "output for codex-1" });

    const attachRes = await fetch(`${base}/live-pane/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", startLine: -90, cols: 100, rows: 32 }),
    });
    const attach = (await attachRes.json()) as {
      ok: boolean;
      sessionId: string;
      stream: { route: string; sessionId: string; startLine: number };
      resize?: { cols: number; rows: number };
    };
    expect(attachRes.ok).toBe(true);
    expect(attach.stream).toEqual({ route: "/events", sessionId: "codex-1", startLine: -90 });
    expect(attach.resize).toEqual({ cols: 100, rows: 32 });

    const inputRes = await fetch(`${base}/live-pane/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", text: "hello" }),
    });
    expect(inputRes.ok).toBe(true);

    const interruptRes = await fetch(`${base}/live-pane/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1" }),
    });
    expect(interruptRes.ok).toBe(true);

    const missingInterruptSessionRes = await fetch(`${base}/live-pane/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingInterruptSessionRes.status).toBe(400);

    const resizeRes = await fetch(`${base}/live-pane/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", cols: 120, rows: 40 }),
    });
    expect(resizeRes.ok).toBe(true);

    const malformedColsRes = await fetch(`${base}/live-pane/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", cols: "100px", rows: 40 }),
    });
    expect(malformedColsRes.status).toBe(400);

    const malformedRowsRes = await fetch(`${base}/live-pane/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", cols: 100, rows: "10.5" }),
    });
    expect(malformedRowsRes.status).toBe(400);

    const malformedAttachRes = await fetch(`${base}/live-pane/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", startLine: "10px" }),
    });
    expect(malformedAttachRes.status).toBe(400);

    const partialAttachResizeRes = await fetch(`${base}/live-pane/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", cols: 100 }),
    });
    expect(partialAttachResizeRes.status).toBe(400);

    const malformedOutputRes = await fetch(`${base}/live-pane/output?sessionId=codex-1&startLine=10.5`);
    expect(malformedOutputRes.status).toBe(400);

    expect(calls).toEqual([
      { kind: "resize", sessionId: "codex-1", cols: 100, rows: 32 },
      { kind: "input", sessionId: "codex-1", text: "hello" },
      { kind: "interrupt", sessionId: "codex-1" },
      { kind: "resize", sessionId: "codex-1", cols: 120, rows: 40 },
    ]);
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
    const onChange = vi.fn();
    server = new MetadataServer({
      onChange,
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
    const switched: Array<{ tty: string; target: unknown }> = [];
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const getTargetByWindowId = TmuxRuntimeManager.prototype.getTargetByWindowId;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    const findClientByTty = TmuxRuntimeManager.prototype.findClientByTty;
    const getAttachedClientForTarget = TmuxRuntimeManager.prototype.getAttachedClientForTarget;
    const openTarget = TmuxRuntimeManager.prototype.openTarget;
    const switchClientToTarget = TmuxRuntimeManager.prototype.switchClientToTarget;
    const refreshStatus = TmuxRuntimeManager.prototype.refreshStatus;
    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-test" }) as any;
    TmuxRuntimeManager.prototype.hasSession = (sessionName) => sessionName === "aimux-test-client-12345678";
    TmuxRuntimeManager.prototype.getTargetByWindowId = (_sessionName, windowId) =>
      windowId === "@7" ? target : undefined;
    TmuxRuntimeManager.prototype.isWindowAlive = () => true;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target,
          metadata: {
            kind: "agent",
            sessionId: "teammate-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
      ] as any;
    TmuxRuntimeManager.prototype.findClientByTty = (tty) =>
      tty === "/dev/ttys001" ? ({ tty, sessionName: "aimux-test-client-12345678" } as any) : null;
    TmuxRuntimeManager.prototype.getAttachedClientForTarget = () => undefined as any;
    TmuxRuntimeManager.prototype.openTarget = vi.fn();
    TmuxRuntimeManager.prototype.switchClientToTarget = (tty, nextTarget) => {
      switched.push({ tty, target: nextTarget });
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
        body: JSON.stringify({
          sessionId: "teammate-1",
          currentClientSession: "aimux-test-client-12345678",
          clientTty: "/dev/ttys001",
          focus: true,
        }),
      });

      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok: boolean; focused: boolean; focusMode?: string; target?: unknown };
      expect(body).toMatchObject({
        ok: true,
        focused: true,
        focusMode: "client-tty",
        target: { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" },
      });
      expect(switched).toEqual([{ tty: "/dev/ttys001", target }]);
      expect(TmuxRuntimeManager.prototype.openTarget).not.toHaveBeenCalled();
      expect(loadMetadataState().sessions["teammate-1"]?.derived).toMatchObject({
        attention: "normal",
        unseenCount: 0,
      });
      expect(listNotifications({ sessionId: "teammate-1" })[0]?.unread).toBe(false);
      expect(onChange).toHaveBeenCalledTimes(1);

      updateSessionMetadata("teammate-1", (current) => ({
        ...current,
        derived: {
          ...(current.derived ?? {}),
          activity: "waiting",
          attention: "needs_input",
          unseenCount: 3,
        },
      }));
      onChange.mockClear();
      const resolveOnlyRes = await fetch(`${base}/control/open-notification-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "teammate-1" }),
      });
      const resolveOnly = (await resolveOnlyRes.json()) as { ok: boolean; focused: boolean; target?: unknown };

      expect(resolveOnlyRes.ok).toBe(true);
      expect(resolveOnly).toMatchObject({
        ok: true,
        focused: false,
        target: { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" },
      });
      expect(switched).toEqual([{ tty: "/dev/ttys001", target }]);
      expect(loadMetadataState().sessions["teammate-1"]?.derived).toMatchObject({
        attention: "needs_input",
        unseenCount: 3,
      });
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.getTargetByWindowId = getTargetByWindowId;
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
      TmuxRuntimeManager.prototype.findClientByTty = findClientByTty;
      TmuxRuntimeManager.prototype.getAttachedClientForTarget = getAttachedClientForTarget;
      TmuxRuntimeManager.prototype.openTarget = openTarget;
      TmuxRuntimeManager.prototype.switchClientToTarget = switchClientToTarget;
      TmuxRuntimeManager.prototype.refreshStatus = refreshStatus;
    }
  });

  it("does not resume offline notification targets from open routes", async () => {
    server?.stop();
    const resumeService = vi.fn();
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [],
          teammates: [],
          services: [{ id: "svc-1", command: "yarn dev", status: "offline", tmuxWindowId: "@stale" }],
        }),
        resumeService,
      },
    });
    TmuxRuntimeManager.prototype.listProjectManagedWindows = vi.fn(() => {
      throw new Error("stale offline window id should not be resolved");
    });
    try {
      await server.start();
      const endpoint = server.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/open-notification-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "svc-1", focus: false }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string; itemId?: string };

      expect(res.status).toBe(409);
      expect(body).toMatchObject({ ok: false, error: "service is offline", itemId: "svc-1" });
      expect(resumeService).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.listProjectManagedWindows).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
    }
  });

  it("does not trust stale exited agent window ids from open routes", async () => {
    server?.stop();
    const resumeAgent = vi.fn();
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "agent-1", command: "codex", status: "exited", tmuxWindowId: "@stale" }],
          teammates: [],
          services: [],
        }),
        resumeAgent,
      },
    });
    TmuxRuntimeManager.prototype.listProjectManagedWindows = vi.fn(() => {
      throw new Error("stale exited window id should not be resolved");
    });
    try {
      await server.start();
      const endpoint = server.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/open-notification-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "agent-1", focus: false }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string; itemId?: string };

      expect(res.status).toBe(409);
      expect(body).toMatchObject({ ok: false, error: "agent is offline", itemId: "agent-1" });
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.listProjectManagedWindows).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
    }
  });

  it("rejects offline service notification targets without resuming", async () => {
    server?.stop();
    const onChange = vi.fn();
    const resumeService = vi.fn();
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const findClientByTty = TmuxRuntimeManager.prototype.findClientByTty;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [],
          teammates: [],
          services: [{ id: "svc-1", command: "shell", status: "offline" }],
        }),
        resumeService,
      },
      onChange,
    });
    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-test" }) as any;
    TmuxRuntimeManager.prototype.hasSession = (sessionName) => sessionName === "aimux-test-client-12345678";
    TmuxRuntimeManager.prototype.findClientByTty = (tty) =>
      tty === "/dev/ttys001" ? ({ tty, sessionName: "aimux-test-client-12345678" } as any) : null;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = vi.fn(() => {
      throw new Error("offline service open should not resolve tmux windows");
    });
    try {
      await server.start();
      const endpoint = server.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/open-notification-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "svc-1",
          currentClientSession: "aimux-test-client-12345678",
          clientTty: "/dev/ttys001",
          focus: true,
        }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };

      expect(res.status).toBe(409);
      expect(body).toEqual({ ok: false, error: "service is offline", itemId: "svc-1" });
      expect(resumeService).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.listProjectManagedWindows).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.findClientByTty = findClientByTty;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
    }
  });

  it("rejects offline agent notification targets without resuming", async () => {
    server?.stop();
    const onChange = vi.fn();
    const resumeAgent = vi.fn();
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const findClientByTty = TmuxRuntimeManager.prototype.findClientByTty;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "agent-1", command: "codex", status: "offline" }],
          teammates: [],
          services: [],
        }),
        resumeAgent,
      },
      onChange,
    });
    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-test" }) as any;
    TmuxRuntimeManager.prototype.hasSession = (sessionName) => sessionName === "aimux-test-client-12345678";
    TmuxRuntimeManager.prototype.findClientByTty = (tty) =>
      tty === "/dev/ttys001" ? ({ tty, sessionName: "aimux-test-client-12345678" } as any) : null;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = vi.fn(() => {
      throw new Error("offline agent open should not resolve tmux windows");
    });
    try {
      await server.start();
      const endpoint = server.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/open-notification-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "agent-1",
          currentClientSession: "aimux-test-client-12345678",
          clientTty: "/dev/ttys001",
          focus: true,
        }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };

      expect(res.status).toBe(409);
      expect(body).toEqual({ ok: false, error: "agent is offline", itemId: "agent-1" });
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.listProjectManagedWindows).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.findClientByTty = findClientByTty;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
    }
  });

  it("rejects dead notification target windows", async () => {
    server?.stop();
    const target = { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" } as any;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "agent-1", command: "codex", status: "running", tmuxWindowId: "@7" }],
          teammates: [],
          services: [],
        }),
      },
    });
    TmuxRuntimeManager.prototype.isWindowAlive = () => false;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target,
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
      ] as any;
    try {
      await server.start();
      const endpoint = server.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/open-notification-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "agent-1", focus: false }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };

      expect(res.status).toBe(404);
      expect(body).toEqual({ ok: false, error: "window not found" });
    } finally {
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
    }
  });

  it("falls back to a live same-session notification target when the rendered window id is stale", async () => {
    server?.stop();
    const staleTarget = { sessionName: "aimux-test", windowId: "@stale", windowIndex: 7, windowName: "codex" } as any;
    const liveTarget = { sessionName: "aimux-test", windowId: "@live", windowIndex: 8, windowName: "codex" } as any;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "agent-1", command: "codex", status: "running", tmuxWindowId: "@stale" }],
          teammates: [],
          services: [],
        }),
      },
    });
    TmuxRuntimeManager.prototype.isWindowAlive = (target) => target.windowId !== "@stale";
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target: staleTarget,
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
        {
          target: liveTarget,
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
      ] as any;
    try {
      await server.start();
      const endpoint = server.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/open-notification-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "agent-1", focus: false }),
      });
      const body = (await res.json()) as { ok: boolean; target?: { windowId?: string } };

      expect(res.ok).toBe(true);
      expect(body.ok).toBe(true);
      expect(body.target?.windowId).toBe("@live");
    } finally {
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
    }
  });

  it("rejects unmanaged focus-window targets", async () => {
    const target = { sessionName: "aimux-test", windowId: "@8", windowIndex: 8, windowName: "outside" } as any;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    const getTargetByWindowId = TmuxRuntimeManager.prototype.getTargetByWindowId;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target: { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" },
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
      ] as any;
    TmuxRuntimeManager.prototype.getTargetByWindowId = vi.fn(() => target);

    try {
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/focus-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ windowId: "@8", focus: false }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };

      expect(res.status).toBe(404);
      expect(body).toEqual({ ok: false, error: "window not found" });
      expect(TmuxRuntimeManager.prototype.getTargetByWindowId).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
      TmuxRuntimeManager.prototype.getTargetByWindowId = getTargetByWindowId;
    }
  });

  it("rejects dead managed focus-window targets", async () => {
    const target = { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" } as any;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    TmuxRuntimeManager.prototype.isWindowAlive = () => false;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target,
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
      ] as any;

    try {
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      for (const focus of [false, true]) {
        const res = await fetch(`${base}/control/focus-window`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ windowId: "@7", focus }),
        });
        const body = (await res.json()) as { ok: boolean; error?: string };
        expect(res.status).toBe(404);
        expect(body).toEqual({ ok: false, error: "window not found" });
      }
    } finally {
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
    }
  });

  it("requires an explicit client tty for mutating focus requests", async () => {
    const target = { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" } as any;
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    const getAttachedClientForTarget = TmuxRuntimeManager.prototype.getAttachedClientForTarget;
    const switchClientToTarget = TmuxRuntimeManager.prototype.switchClientToTarget;
    const openTarget = TmuxRuntimeManager.prototype.openTarget;

    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-test" }) as any;
    TmuxRuntimeManager.prototype.hasSession = (sessionName) => sessionName === "aimux-test-client-12345678";
    TmuxRuntimeManager.prototype.isWindowAlive = () => true;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target,
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
      ] as any;
    TmuxRuntimeManager.prototype.getAttachedClientForTarget = vi.fn(() => ({ tty: "/dev/ttys999" }) as any);
    TmuxRuntimeManager.prototype.switchClientToTarget = vi.fn();
    TmuxRuntimeManager.prototype.openTarget = vi.fn();

    try {
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/focus-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ windowId: "@7", currentClientSession: "aimux-test-client-12345678", focus: true }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };

      expect(res.status).toBe(400);
      expect(body).toEqual({ ok: false, error: "clientTty is required" });
      expect(TmuxRuntimeManager.prototype.getAttachedClientForTarget).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.switchClientToTarget).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.openTarget).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
      TmuxRuntimeManager.prototype.getAttachedClientForTarget = getAttachedClientForTarget;
      TmuxRuntimeManager.prototype.switchClientToTarget = switchClientToTarget;
      TmuxRuntimeManager.prototype.openTarget = openTarget;
    }
  });

  it("uses live client tty over a stale currentClientSession for focus requests", async () => {
    const target = { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" } as any;
    const switched: Array<{ tty: string; target: unknown }> = [];
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const findClientByTty = TmuxRuntimeManager.prototype.findClientByTty;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    const getAttachedClientForTarget = TmuxRuntimeManager.prototype.getAttachedClientForTarget;
    const switchClientToTarget = TmuxRuntimeManager.prototype.switchClientToTarget;
    const openTarget = TmuxRuntimeManager.prototype.openTarget;

    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-test" }) as any;
    TmuxRuntimeManager.prototype.hasSession = (sessionName) => sessionName === "aimux-test-client-abcdef12";
    TmuxRuntimeManager.prototype.findClientByTty = (tty) =>
      tty === "/dev/ttys001" ? ({ tty, sessionName: "aimux-test-client-abcdef12" } as any) : null;
    TmuxRuntimeManager.prototype.isWindowAlive = () => true;
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target,
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
      ] as any;
    TmuxRuntimeManager.prototype.getAttachedClientForTarget = vi.fn(() => undefined as any);
    TmuxRuntimeManager.prototype.switchClientToTarget = (tty, nextTarget) => {
      switched.push({ tty, target: nextTarget });
    };
    TmuxRuntimeManager.prototype.openTarget = vi.fn();

    try {
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/control/focus-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          windowId: "@7",
          currentClientSession: "aimux-test-client-deadbeef",
          clientTty: "/dev/ttys001",
          focus: true,
        }),
      });
      const body = (await res.json()) as { ok: boolean; focused?: boolean; focusMode?: string };

      expect(res.ok).toBe(true);
      expect(body).toMatchObject({ ok: true, focused: true, focusMode: "client-tty" });
      expect(switched).toEqual([{ tty: "/dev/ttys001", target }]);
      expect(TmuxRuntimeManager.prototype.openTarget).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.findClientByTty = findClientByTty;
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
      TmuxRuntimeManager.prototype.getAttachedClientForTarget = getAttachedClientForTarget;
      TmuxRuntimeManager.prototype.switchClientToTarget = switchClientToTarget;
      TmuxRuntimeManager.prototype.openTarget = openTarget;
    }
  });

  it("resolves dashboard locations without mutating tmux state when focus is false", async () => {
    const target = {
      sessionName: "aimux-repo-abc-client-12345678",
      windowId: "@99",
      windowIndex: 0,
      windowName: "dashboard-123",
    } as any;
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const listSessionNames = TmuxRuntimeManager.prototype.listSessionNames;
    const listWindows = TmuxRuntimeManager.prototype.listWindows;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const getWindowOption = TmuxRuntimeManager.prototype.getWindowOption;
    const getSessionOption = TmuxRuntimeManager.prototype.getSessionOption;
    const displayMessage = TmuxRuntimeManager.prototype.displayMessage;
    const captureTarget = TmuxRuntimeManager.prototype.captureTarget;
    const ensureProjectSession = TmuxRuntimeManager.prototype.ensureProjectSession;
    const ensureDashboardWindow = TmuxRuntimeManager.prototype.ensureDashboardWindow;
    const respawnWindow = TmuxRuntimeManager.prototype.respawnWindow;
    const setWindowOption = TmuxRuntimeManager.prototype.setWindowOption;

    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-repo-abc" }) as any;
    TmuxRuntimeManager.prototype.hasSession = (sessionName) => sessionName === "aimux-repo-abc-client-12345678";
    TmuxRuntimeManager.prototype.listSessionNames = () => ["aimux-repo-abc", "aimux-repo-abc-client-12345678"];
    TmuxRuntimeManager.prototype.listWindows = (sessionName) =>
      sessionName === "aimux-repo-abc-client-12345678"
        ? [{ id: target.windowId, index: target.windowIndex, name: target.windowName, active: true }]
        : [];
    TmuxRuntimeManager.prototype.isWindowAlive = () => true;
    TmuxRuntimeManager.prototype.getWindowOption = (_target, key) =>
      key === TMUX_DASHBOARD_OWNER_OPTION
        ? getRuntimeOwnerId()
        : key === TMUX_DASHBOARD_READY_OPTION
          ? getDashboardCommandSpec(repoRoot).dashboardBuildStamp
          : key === "@aimux-dashboard-build"
            ? getDashboardCommandSpec(repoRoot).dashboardBuildStamp
            : "";
    TmuxRuntimeManager.prototype.getSessionOption = (_sessionName, key) =>
      key === TMUX_RUNTIME_OWNER_OPTION ? getRuntimeOwnerId() : key === "@aimux-project-root" ? repoRoot : "";
    TmuxRuntimeManager.prototype.displayMessage = () => "bash";
    TmuxRuntimeManager.prototype.captureTarget = () => "";
    TmuxRuntimeManager.prototype.ensureProjectSession = vi.fn();
    TmuxRuntimeManager.prototype.ensureDashboardWindow = vi.fn();
    TmuxRuntimeManager.prototype.respawnWindow = vi.fn();
    TmuxRuntimeManager.prototype.setWindowOption = vi.fn();

    try {
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const dashboardRes = await fetch(`${base}/control/open-dashboard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentClientSession: "aimux-repo-abc-client-12345678",
          currentWindowId: "@42",
          focus: false,
        }),
      });
      const dashboardBody = (await dashboardRes.json()) as { ok: boolean; focused: boolean; target?: unknown };

      const coordinationResolveRes = await fetch(`${base}/control/open-dashboard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentClientSession: "aimux-repo-abc-client-12345678",
          focus: false,
          screen: "coordination",
        }),
      });
      const coordinationResolveBody = (await coordinationResolveRes.json()) as {
        ok: boolean;
        focused: boolean;
        target?: unknown;
      };

      expect(dashboardRes.ok).toBe(true);
      expect(dashboardBody).toMatchObject({ ok: true, focused: false, target });
      expect(coordinationResolveRes.ok).toBe(true);
      expect(coordinationResolveBody).toMatchObject({ ok: true, focused: false, target });
      const coordinationResolveSnapshot = JSON.parse(
        readFileSync(getDashboardClientUiStatePath("aimux-repo-abc-client-12345678"), "utf-8"),
      ) as Record<string, unknown>;
      expect(coordinationResolveSnapshot.screen).toBe("coordination");
      expect(TmuxRuntimeManager.prototype.ensureProjectSession).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.ensureDashboardWindow).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.respawnWindow).not.toHaveBeenCalled();
      expect(TmuxRuntimeManager.prototype.setWindowOption).not.toHaveBeenCalled();
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.listSessionNames = listSessionNames;
      TmuxRuntimeManager.prototype.listWindows = listWindows;
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.getWindowOption = getWindowOption;
      TmuxRuntimeManager.prototype.getSessionOption = getSessionOption;
      TmuxRuntimeManager.prototype.displayMessage = displayMessage;
      TmuxRuntimeManager.prototype.captureTarget = captureTarget;
      TmuxRuntimeManager.prototype.ensureProjectSession = ensureProjectSession;
      TmuxRuntimeManager.prototype.ensureDashboardWindow = ensureDashboardWindow;
      TmuxRuntimeManager.prototype.respawnWindow = respawnWindow;
      TmuxRuntimeManager.prototype.setWindowOption = setWindowOption;
    }
  });

  it("validates active-window reports before mutating notification context", async () => {
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const listSessionNames = TmuxRuntimeManager.prototype.listSessionNames;
    const listWindows = TmuxRuntimeManager.prototype.listWindows;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const getWindowOption = TmuxRuntimeManager.prototype.getWindowOption;
    const getSessionOption = TmuxRuntimeManager.prototype.getSessionOption;
    const displayMessage = TmuxRuntimeManager.prototype.displayMessage;
    const captureTarget = TmuxRuntimeManager.prototype.captureTarget;
    const listManagedWindows = TmuxRuntimeManager.prototype.listManagedWindows;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    const findClientByTty = TmuxRuntimeManager.prototype.findClientByTty;

    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-test" }) as any;
    TmuxRuntimeManager.prototype.hasSession = (sessionName) => sessionName === "aimux-test-client-12345678";
    TmuxRuntimeManager.prototype.listSessionNames = () => ["aimux-test", "aimux-test-client-12345678"];
    TmuxRuntimeManager.prototype.listWindows = (sessionName) =>
      sessionName === "aimux-test-client-12345678"
        ? [{ id: "@99", index: 0, name: "dashboard-123", active: true }]
        : [];
    TmuxRuntimeManager.prototype.isWindowAlive = () => true;
    TmuxRuntimeManager.prototype.getWindowOption = (_target, key) =>
      key === TMUX_DASHBOARD_OWNER_OPTION
        ? getRuntimeOwnerId()
        : key === TMUX_DASHBOARD_READY_OPTION
          ? getDashboardCommandSpec(repoRoot).dashboardBuildStamp
          : key === "@aimux-dashboard-build"
            ? getDashboardCommandSpec(repoRoot).dashboardBuildStamp
            : "";
    TmuxRuntimeManager.prototype.getSessionOption = (_sessionName, key) =>
      key === TMUX_RUNTIME_OWNER_OPTION ? getRuntimeOwnerId() : key === "@aimux-project-root" ? repoRoot : "";
    TmuxRuntimeManager.prototype.displayMessage = () => "bash";
    TmuxRuntimeManager.prototype.captureTarget = () => "";
    TmuxRuntimeManager.prototype.findClientByTty = (tty) =>
      tty === "/dev/ttys001" ? ({ tty, sessionName: "aimux-test-client-12345678" } as any) : null;
    TmuxRuntimeManager.prototype.listManagedWindows = vi.fn(() => {
      throw new Error("switch resolver should not run for invalid client sessions");
    });
    TmuxRuntimeManager.prototype.listProjectManagedWindows = () =>
      [
        {
          target: { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" },
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
          },
        },
      ] as any;

    try {
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const missingSessionRes = await fetch(`${base}/control/active-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentWindowId: "@99" }),
      });
      const missingSessionBody = (await missingSessionRes.json()) as { ok: boolean; error?: string };
      expect(missingSessionRes.status).toBe(400);
      expect(missingSessionBody).toEqual({ ok: false, error: "currentClientSession is required" });

      const missingTtyRes = await fetch(`${base}/control/active-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentClientSession: "aimux-test-client-12345678", currentWindowId: "@99" }),
      });
      const missingTtyBody = (await missingTtyRes.json()) as { ok: boolean; error?: string };
      expect(missingTtyRes.status).toBe(400);
      expect(missingTtyBody).toEqual({ ok: false, error: "clientTty is required" });

      const invalidSessionRes = await fetch(`${base}/control/active-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentClientSession: "other-client",
          clientTty: "/dev/ttys001",
          currentWindowId: "@7",
        }),
      });
      const invalidSessionBody = (await invalidSessionRes.json()) as { ok: boolean; error?: string };
      expect(invalidSessionRes.status).toBe(400);
      expect(invalidSessionBody).toEqual({ ok: false, error: "currentClientSession is not a project client" });

      const invalidSwitchRes = await fetch(`${base}/control/switch-next`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentClientSession: "other-client", focus: false }),
      });
      const invalidSwitchBody = (await invalidSwitchRes.json()) as { ok: boolean; error?: string };
      expect(invalidSwitchRes.status).toBe(400);
      expect(invalidSwitchBody).toEqual({ ok: false, error: "currentClientSession is not a project client" });
      expect(TmuxRuntimeManager.prototype.listManagedWindows).not.toHaveBeenCalled();

      TmuxRuntimeManager.prototype.listWindows = (sessionName) =>
        sessionName === "aimux-test-client-12345678" ? [{ id: "@7", index: 7, name: "codex", active: true }] : [];
      TmuxRuntimeManager.prototype.isWindowAlive = (target) => target.windowId !== "@7";
      const deadManagedRes = await fetch(`${base}/control/active-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentClientSession: "aimux-test-client-12345678",
          clientTty: "/dev/ttys001",
          currentWindow: "codex",
          currentWindowId: "@7",
        }),
      });
      const deadManagedBody = (await deadManagedRes.json()) as { ok: boolean; error?: string };
      expect(deadManagedRes.status).toBe(404);
      expect(deadManagedBody).toEqual({ ok: false, error: "window not found" });
      expect(loadNotificationContexts().contexts.tui).toBeUndefined();
      TmuxRuntimeManager.prototype.listWindows = (sessionName) =>
        sessionName === "aimux-test-client-12345678"
          ? [{ id: "@99", index: 0, name: "dashboard-123", active: true }]
          : [];
      TmuxRuntimeManager.prototype.isWindowAlive = () => true;

      const spoofedDashboardRes = await fetch(`${base}/control/active-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentClientSession: "aimux-test-client-12345678",
          clientTty: "/dev/ttys001",
          currentWindow: "dashboard-123",
          currentWindowId: "@7",
        }),
      });
      const spoofedDashboardBody = (await spoofedDashboardRes.json()) as { ok: boolean; error?: string };
      expect(spoofedDashboardRes.status).toBe(404);
      expect(spoofedDashboardBody).toEqual({ ok: false, error: "window not found" });
      expect(loadNotificationContexts().contexts.tui).toBeUndefined();

      const dashboardRes = await fetch(`${base}/control/active-window`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentClientSession: "aimux-test-client-12345678",
          clientTty: "/dev/ttys001",
          currentWindow: "dashboard-123",
          currentWindowId: "@99",
        }),
      });
      expect(dashboardRes.ok).toBe(true);
      expect(loadNotificationContexts().contexts.tui).toMatchObject({ focused: true, screen: "dashboard" });
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.listSessionNames = listSessionNames;
      TmuxRuntimeManager.prototype.listWindows = listWindows;
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.getWindowOption = getWindowOption;
      TmuxRuntimeManager.prototype.getSessionOption = getSessionOption;
      TmuxRuntimeManager.prototype.displayMessage = displayMessage;
      TmuxRuntimeManager.prototype.captureTarget = captureTarget;
      TmuxRuntimeManager.prototype.listManagedWindows = listManagedWindows;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
      TmuxRuntimeManager.prototype.findClientByTty = findClientByTty;
    }
  });

  it("attaches cached expose preview snapshots to switchable-agent responses", async () => {
    server?.stop();
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const listManagedWindows = TmuxRuntimeManager.prototype.listManagedWindows;
    const listWindows = TmuxRuntimeManager.prototype.listWindows;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const captureSnapshot = {
      output: "capture preview\n",
      capturedAt: "2026-07-20T13:00:00.000Z",
      source: "capture" as const,
      windowId: "@7",
      startLine: -40,
      lineCount: 40,
    };
    const repairCaptureSnapshot = {
      output: "repair capture\n",
      capturedAt: "2026-07-20T13:00:02.000Z",
      source: "capture" as const,
      windowId: "@8",
      startLine: -40,
      lineCount: 40,
    };
    const exposePreviewCache = {
      start: vi.fn(),
      stop: vi.fn(),
      trackItems: vi.fn(),
      get: vi.fn((windowId: string) =>
        windowId === "@7" ? captureSnapshot : windowId === "@8" ? repairCaptureSnapshot : undefined,
      ),
    };
    const exposePaneOutputTap = {
      start: vi.fn(),
      stop: vi.fn(),
      trackItems: vi.fn(),
      read: vi.fn((windowId: string) =>
        windowId === "@7"
          ? {
              output: "live tap preview\n",
              capturedAt: "2026-07-20T13:00:01.000Z",
              source: "tap" as const,
              windowId: "@7",
              byteCount: 17,
            }
          : windowId === "@9"
            ? {
                output: "tap only preview\n",
                capturedAt: "2026-07-20T13:00:03.000Z",
                source: "tap" as const,
                windowId: "@9",
                byteCount: 17,
              }
            : undefined,
      ),
    };

    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-test" }) as any;
    TmuxRuntimeManager.prototype.listManagedWindows = () =>
      [
        {
          target: { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" },
          metadata: {
            kind: "agent",
            sessionId: "agent-1",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
            worktreePath: repoRoot,
          },
        },
        {
          target: { sessionName: "aimux-test", windowId: "@8", windowIndex: 8, windowName: "claude" },
          metadata: {
            kind: "agent",
            sessionId: "agent-2",
            command: "claude",
            args: [],
            toolConfigKey: "claude",
            worktreePath: repoRoot,
          },
        },
        {
          target: { sessionName: "aimux-test", windowId: "@9", windowIndex: 9, windowName: "codex" },
          metadata: {
            kind: "agent",
            sessionId: "agent-3",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
            worktreePath: repoRoot,
          },
        },
      ] as any;
    TmuxRuntimeManager.prototype.listWindows = () => [
      { id: "@7", index: 7, name: "codex", active: true, activity: 12 },
      { id: "@8", index: 8, name: "claude", active: false, activity: 13 },
      { id: "@9", index: 9, name: "codex", active: false, activity: 14 },
    ];
    TmuxRuntimeManager.prototype.isWindowAlive = () => true;
    server = new MetadataServer({ exposePreviewCache, exposePaneOutputTap });
    await server.start();

    try {
      const endpoint = server.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}${PROJECT_API_ROUTES.controls.switchableAgents}`;
      const withoutPreview = await fetch(`${base}?scope=all&labelFormat=raw`);
      const withoutPreviewBody = (await withoutPreview.json()) as { ok: boolean; items: Array<Record<string, any>> };
      expect(withoutPreview.status).toBe(200);
      expect(withoutPreviewBody.items[0]?.previewSnapshot).toBeUndefined();
      expect(exposePreviewCache.trackItems).not.toHaveBeenCalled();
      expect(exposePaneOutputTap.trackItems).not.toHaveBeenCalled();
      expect(exposePaneOutputTap.read).not.toHaveBeenCalled();

      const response = await fetch(`${base}?scope=all&labelFormat=raw&includePreview=1`);
      const body = (await response.json()) as { ok: boolean; items: Array<Record<string, any>> };

      expect(response.status).toBe(200);
      expect(body.items.find((item) => item.target.windowId === "@7")?.previewSnapshot).toEqual({
        output: "live tap preview\n",
        capturedAt: "2026-07-20T13:00:01.000Z",
        source: "tap",
        windowId: "@7",
      });
      expect(body.items.find((item) => item.target.windowId === "@8")?.previewSnapshot).toEqual({
        output: "repair capture\n",
        capturedAt: "2026-07-20T13:00:02.000Z",
        source: "capture",
        windowId: "@8",
        startLine: -40,
        lineCount: 40,
      });
      expect(body.items.find((item) => item.target.windowId === "@9")?.previewSnapshot).toEqual({
        output: "tap only preview\n",
        capturedAt: "2026-07-20T13:00:03.000Z",
        source: "tap",
        windowId: "@9",
      });
      expect(exposePaneOutputTap.trackItems).toHaveBeenCalledWith([
        expect.objectContaining({ target: expect.objectContaining({ windowId: "@7" }) }),
        expect.objectContaining({ target: expect.objectContaining({ windowId: "@8" }) }),
        expect.objectContaining({ target: expect.objectContaining({ windowId: "@9" }) }),
      ]);
      expect(exposePreviewCache.trackItems).toHaveBeenCalledWith([
        expect.objectContaining({ target: expect.objectContaining({ windowId: "@8" }) }),
      ]);
      expect(exposePreviewCache.get).not.toHaveBeenCalledWith("@7");
      expect(exposePreviewCache.get).toHaveBeenCalledWith("@8");
      expect(exposePaneOutputTap.read).toHaveBeenCalledWith("@8");
      expect(exposePaneOutputTap.read).toHaveBeenCalledWith("@7");
      expect(exposePaneOutputTap.read).toHaveBeenCalledWith("@9");
      expect(exposePreviewCache.start).toHaveBeenCalledTimes(1);
      expect(exposePaneOutputTap.start).toHaveBeenCalledTimes(1);
    } finally {
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.listManagedWindows = listManagedWindows;
      TmuxRuntimeManager.prototype.listWindows = listWindows;
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
    }
  });

  it("serves a reconciled coordination worklist from desktop state + notifications", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [
            {
              id: "live-1",
              command: "claude",
              status: "running",
              semantic: { user: { label: "needs_input" }, presentation: { attentionScore: 4 } },
            },
          ],
          teammates: [],
          services: [],
        }),
      },
    });
    await server.start();

    upsertNotification({
      title: "Needs input",
      body: "live agent needs input",
      sessionId: "live-1",
      kind: "needs_input",
    });
    upsertNotification({
      title: "Gone",
      body: "vanished agent needs input",
      sessionId: "ghost-1",
      kind: "needs_input",
    });

    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/coordination-worklist`);
    const body = (await res.json()) as {
      ok: boolean;
      worklist: { items: Array<{ key: string; sessionId?: string; bucket: string; reachability: string }> };
      model: { items: Array<{ key: string }> };
      threads: unknown[];
    };

    expect(res.ok).toBe(true);
    expect(body.ok).toBe(true);
    const live = body.worklist.items.find((item) => item.sessionId === "live-1");
    const ghost = body.worklist.items.find((item) => item.sessionId === "ghost-1");
    expect(live).toMatchObject({ bucket: "awake", reachability: "live" });
    expect(ghost).toMatchObject({ bucket: "unreachable", reachability: "missing" });
    // Awake (actionable) sorts ahead of the unreachable tail.
    const keys = body.worklist.items.map((item) => item.key);
    expect(keys.indexOf("n:live-1")).toBeLessThan(keys.indexOf("n:ghost-1"));
    expect(Array.isArray(body.threads)).toBe(true);
  });

  it("serves orchestration route options from desktop state", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [
            {
              id: "codex-1",
              command: "custom-codex-command",
              toolConfigKey: "codex",
              status: "idle",
              label: "Reviewer",
              semantic: {
                user: { label: "idle" },
                runtime: { canReceiveInput: true, isAlive: true },
              },
            },
          ],
          teammates: [],
          services: [],
        }),
      },
    });
    await server.start();

    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/orchestration/routes?selectedSessionId=codex-1`);
    const body = (await res.json()) as {
      ok: boolean;
      options: Array<{ label: string; sessionId?: string }>;
    };

    expect(res.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.options[0]).toEqual({ label: "Reviewer (codex-1)", sessionId: "codex-1" });
    expect(body.options).toContainEqual({
      label: "Tool: codex [1: codex-1]",
      tool: "codex",
      recipientIds: ["codex-1"],
    });
  });

  it("clears dashboard operation failures over HTTP", async () => {
    const failure = addDashboardOperationFailure({
      targetKind: "worktree",
      operation: "create",
      title: "Failed to create worktree",
      message: "boom",
      worktreePath: "/repo/.aimux/worktrees/demo",
    });
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/operation-failures/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetKind: "worktree",
        operation: "create",
        worktreePath: failure.worktreePath,
      }),
    });
    const body = (await res.json()) as { ok: boolean; cleared: number };

    expect(res.ok).toBe(true);
    expect(body).toEqual({ ok: true, cleared: 1 });
    expect(listDashboardOperationFailures()).toHaveLength(0);
  });

  it("serves project observability from desktop state, tasks, and notifications", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          sessions: [{ id: "live-1", command: "claude", status: "running" }],
          teammates: [{ id: "team-1", command: "codex", status: "waiting" }],
          services: [{ id: "svc-1", command: "yarn dev", status: "running" }],
          worktrees: [{ name: "main", path: repoRoot, branch: "main" }],
        }),
      },
    });
    await server.start();

    upsertNotification({ title: "Needs input", body: "body", sessionId: "live-1", kind: "needs_input" });

    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/project-observability`);
    const body = (await res.json()) as {
      ok: boolean;
      project: {
        summary: {
          agentsRunning: number;
          agentsWaiting: number;
          services: number;
          worktrees: number;
          unreadNotifications: number;
        };
      };
    };

    expect(res.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.project.summary).toMatchObject({
      agentsRunning: 1,
      agentsWaiting: 1,
      services: 1,
      worktrees: 1,
      unreadNotifications: 1,
    });
  });

  it("serves topology from grouped desktop worktree state", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getState: () => ({
          mainCheckoutInfo: { name: "aimux" },
          sessions: [
            { id: "live-1", command: "claude", status: "running", worktreePath: "/repo" },
            { id: "main-1", command: "shell", status: "idle" },
          ],
          teammates: [{ id: "team-1", command: "codex", status: "waiting", worktreePath: "/repo" }],
          services: [{ id: "svc-1", command: "yarn dev", status: "running", worktreePath: "/repo" }],
          worktrees: [
            { name: "main", path: "/repo", branch: "main" },
            { name: "empty", path: "/empty", branch: "empty" },
          ],
        }),
      },
    });
    await server.start();

    const endpoint = server.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/topology`);
    const body = (await res.json()) as {
      ok: boolean;
      topology: {
        projectName: string;
        counts: { worktrees: number; agents: number; services: number };
        rows: Array<{ kind: string; label?: string; status?: string; sessionId?: string; serviceId?: string }>;
      };
    };

    expect(res.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.topology.projectName).toBe("aimux");
    expect(body.topology.counts).toEqual({ worktrees: 2, agents: 3, services: 1 });
    expect(body.topology.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "worktree", label: "empty", status: "offline" }),
        expect.objectContaining({ kind: "agent", sessionId: "live-1" }),
        expect.objectContaining({ kind: "agent", sessionId: "main-1" }),
        expect.objectContaining({ kind: "agent", sessionId: "team-1" }),
        expect.objectContaining({ kind: "service", serviceId: "svc-1" }),
      ]),
    );
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
      transition: {
        operation: "agent.stop",
        targetKind: "agent",
        targetId: "child",
        phase: "succeeded",
      },
    });
    expect((await (await request("/agents/teammates/resume")).json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      sessionId: "child",
      teammateSessionId: "child",
      transition: {
        operation: "agent.resume",
        targetKind: "agent",
        targetId: "child",
        phase: "succeeded",
      },
    });
    expect((await (await request("/agents/teammates/kill")).json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      sessionId: "child",
      teammateSessionId: "child",
      status: "graveyard",
      transition: {
        operation: "agent.kill",
        targetKind: "agent",
        targetId: "child",
        phase: "succeeded",
      },
    });

    const foreign = await request("/agents/teammates/stop", "other-child");
    const foreignBody = (await foreign.json()) as { ok: boolean; error: string };
    expect(foreign.status).toBe(404);
    expect(foreignBody.error).toContain("not attached");
    expect(calls).toEqual(["stop:child", "resume:child", "kill:child"]);
  });

  it("returns canonical lifecycle transitions for mutation responses", async () => {
    server?.stop();
    rmSync(join(repoRoot, ".git"), { recursive: true, force: true });
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    const canonicalRepoRoot = realpathSync(repoRoot);
    let resolveCreateWorktree: (() => void) | null = null;
    const featureAPath = join(canonicalRepoRoot, ".aimux", "worktrees", "feature-a");
    const featureSyncPath = join(canonicalRepoRoot, ".aimux", "worktrees", "feature-sync");
    server = new MetadataServer({
      projectRoot: repoRoot,
      desktop: {
        resumeAgent: ({ sessionId }) => ({ sessionId, status: "running" as const }),
        createService: ({ serviceId }) => ({ serviceId: serviceId ?? "svc-1" }),
        stopService: ({ serviceId }) => ({ serviceId, status: "stopped" as const }),
        resumeService: () => {
          throw new Error("resume failed");
        },
        createWorktree: ({ name }) => {
          if (name === "feature-sync") {
            return { path: featureSyncPath, status: "creating" };
          }
          return new Promise<{ path: string }>((resolve) => {
            resolveCreateWorktree = () => resolve({ path: join(repoRoot, ".aimux", "worktrees", name) });
          });
        },
        removeWorktree: () => {
          throw new Error("remove failed");
        },
        graveyardWorktree: ({ path }) => ({ path, status: "graveyarded" as const }),
      },
      lifecycle: {
        spawnAgent: ({ sessionId }) => ({ sessionId: sessionId ?? "claude-new" }),
        stopAgent: ({ sessionId }) => ({ sessionId, status: "offline" as const }),
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const post = async (path: string, payload: Record<string, unknown>) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    const spawn = await post(PROJECT_API_ROUTES.agents.spawn, { tool: "claude" });
    expect(spawn.status).toBe(200);
    expect(spawn.body.transition).toMatchObject({
      operation: "agent.spawn",
      targetKind: "agent",
      targetId: "claude-new",
      phase: "succeeded",
      operationId: expect.any(String),
      startedAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const resume = await post(PROJECT_API_ROUTES.agents.resume, { sessionId: "claude-old" });
    expect(resume.body.transition).toMatchObject({
      operation: "agent.resume",
      targetKind: "agent",
      targetId: "claude-old",
      phase: "succeeded",
    });

    const service = await post(PROJECT_API_ROUTES.services.stop, { serviceId: "svc-1" });
    expect(service.body.transition).toMatchObject({
      operation: "service.stop",
      targetKind: "service",
      targetId: "svc-1",
      phase: "succeeded",
    });

    const pendingWorktree = await post(PROJECT_API_ROUTES.worktreeActions.create, { name: "feature-a" });
    expect(pendingWorktree.status).toBe(202);
    expect(pendingWorktree.body).toMatchObject({
      ok: true,
      path: featureAPath,
      status: "creating",
      transition: {
        operation: "worktree.create",
        targetKind: "worktree",
        targetId: "feature-a",
        targetPath: featureAPath,
        phase: "settling",
      },
    });
    resolveCreateWorktree?.();

    const syncPendingWorktree = await post(PROJECT_API_ROUTES.worktreeActions.create, { name: "feature-sync" });
    expect(syncPendingWorktree.status).toBe(202);
    expect(syncPendingWorktree.body).toMatchObject({
      ok: true,
      path: featureSyncPath,
      status: "creating",
      transition: {
        operation: "worktree.create",
        targetKind: "worktree",
        targetId: "feature-sync",
        targetPath: featureSyncPath,
        phase: "settling",
      },
    });

    const graveyardWorktree = await post(PROJECT_API_ROUTES.worktreeActions.graveyard, {
      path: "/repo/.aimux/worktrees/feature-a",
    });
    expect(graveyardWorktree.body.transition).toMatchObject({
      operation: "worktree.graveyard",
      targetKind: "worktree",
      targetPath: "/repo/.aimux/worktrees/feature-a",
      phase: "succeeded",
    });

    const failedService = await post(PROJECT_API_ROUTES.services.resume, { serviceId: "missing-service" });
    expect(failedService.status).toBe(500);
    expect(failedService.body).toMatchObject({
      ok: false,
      error: "resume failed",
      transition: {
        operation: "service.resume",
        targetKind: "service",
        targetId: "missing-service",
        phase: "failed",
        error: "resume failed",
      },
    });

    const failedRemoveWorktree = await post(PROJECT_API_ROUTES.worktreeActions.remove, {
      path: "/repo/.aimux/worktrees/missing-feature",
    });
    expect(failedRemoveWorktree.status).toBe(422);
    expect(failedRemoveWorktree.body).toMatchObject({
      ok: false,
      error: "remove failed",
      transition: {
        operation: "worktree.remove",
        targetKind: "worktree",
        targetPath: "/repo/.aimux/worktrees/missing-feature",
        phase: "failed",
        error: "remove failed",
      },
    });
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

  it("returns graveyard entries with the server-built TUI view model", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getState: () => ({ sessions: [], teammates: [] }),
        listGraveyard: () => [
          {
            id: "codex-old",
            tool: "codex",
            command: "codex",
            status: "graveyard",
          },
        ],
        listWorktreeGraveyard: () => [],
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/graveyard`);
    const body = (await res.json()) as {
      entries: Array<{ id: string }>;
      viewModel: { rows: Array<{ kind: string }>; selectableRows: Array<{ kind: string; entry: { id: string } }> };
    };

    expect(res.status).toBe(200);
    expect(body.entries).toEqual([expect.objectContaining({ id: "codex-old" })]);
    expect(body.viewModel.rows.map((row) => row.kind)).toContain("orphan-agent");
    expect(body.viewModel.selectableRows).toEqual([
      expect.objectContaining({ kind: "orphan-agent", entry: expect.objectContaining({ id: "codex-old" }) }),
    ]);
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
      transition: {
        operation: "agent.spawn",
        targetKind: "agent",
        targetId: "reviewer-1",
        phase: "succeeded",
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      sessionId: "claude-1",
      status: "running",
      transition: { operation: "agent.resume", targetKind: "agent", targetId: "claude-1" },
    });
  });

  it("persists the current live window as the preferred dashboard selection when reopening dashboard", async () => {
    const ensureProjectSession = TmuxRuntimeManager.prototype.ensureProjectSession;
    const getProjectSession = TmuxRuntimeManager.prototype.getProjectSession;
    const hasSession = TmuxRuntimeManager.prototype.hasSession;
    const ensureDashboardWindow = TmuxRuntimeManager.prototype.ensureDashboardWindow;
    const getWindowOption = TmuxRuntimeManager.prototype.getWindowOption;
    const isWindowAlive = TmuxRuntimeManager.prototype.isWindowAlive;
    const replaceWindowWhenReady = TmuxRuntimeManager.prototype.replaceWindowWhenReady;
    const setSessionOption = TmuxRuntimeManager.prototype.setSessionOption;
    const setWindowOption = TmuxRuntimeManager.prototype.setWindowOption;
    const listProjectManagedWindows = TmuxRuntimeManager.prototype.listProjectManagedWindows;
    const listClients = TmuxRuntimeManager.prototype.listClients;
    const findClientByTty = TmuxRuntimeManager.prototype.findClientByTty;
    const getAttachedClientForTarget = TmuxRuntimeManager.prototype.getAttachedClientForTarget;
    const switchClientToTarget = TmuxRuntimeManager.prototype.switchClientToTarget;
    const refreshStatus = TmuxRuntimeManager.prototype.refreshStatus;
    const sendFocusIn = TmuxRuntimeManager.prototype.sendFocusIn;
    const setSessionOptionMock = vi.fn();
    const setWindowOptionMock = vi.fn();
    const replaceWindowWhenReadyMock = vi.fn((target) => target);
    const expectedDashboardBuildStamp = getDashboardCommandSpec(process.cwd()).dashboardBuildStamp;
    const switchClientToTargetMock = vi.fn((_tty: string, _target: unknown) => {
      expect(dashboardReadyStamp).toBe(expectedDashboardBuildStamp);
    });
    const sendFocusInMock = vi.fn((_target: unknown) => {
      expect(dashboardReadyStamp).toBe(expectedDashboardBuildStamp);
    });
    let dashboardReadyStamp = expectedDashboardBuildStamp;
    let readyPollsBeforeReady = 0;

    TmuxRuntimeManager.prototype.ensureProjectSession = () => ({ sessionName: "aimux-repo-abc" }) as any;
    TmuxRuntimeManager.prototype.getProjectSession = () => ({ sessionName: "aimux-repo-abc" }) as any;
    TmuxRuntimeManager.prototype.hasSession = () => true;
    TmuxRuntimeManager.prototype.ensureDashboardWindow = () =>
      ({
        sessionName: "aimux-repo-abc-client-12345678",
        windowId: "@99",
        windowIndex: 0,
        windowName: "dashboard-123",
      }) as any;
    TmuxRuntimeManager.prototype.getWindowOption = (_target, key) =>
      key === TMUX_DASHBOARD_OWNER_OPTION
        ? getRuntimeOwnerId()
        : key === TMUX_DASHBOARD_READY_OPTION
          ? dashboardReadyStamp === "pending-ready" && readyPollsBeforeReady++ > 0
            ? (dashboardReadyStamp = expectedDashboardBuildStamp)
            : dashboardReadyStamp
          : key === "@aimux-dashboard-build"
            ? expectedDashboardBuildStamp
            : "";
    TmuxRuntimeManager.prototype.isWindowAlive = () => true;
    TmuxRuntimeManager.prototype.replaceWindowWhenReady = replaceWindowWhenReadyMock;
    TmuxRuntimeManager.prototype.setSessionOption = setSessionOptionMock;
    TmuxRuntimeManager.prototype.setWindowOption = setWindowOptionMock;
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
      [{ tty: "/dev/ttys001", sessionName: "aimux-repo-abc-client-12345678" }] as any;
    TmuxRuntimeManager.prototype.findClientByTty = () =>
      ({ tty: "/dev/ttys001", sessionName: "aimux-repo-abc-client-12345678" }) as any;
    TmuxRuntimeManager.prototype.getAttachedClientForTarget = () => undefined as any;
    TmuxRuntimeManager.prototype.switchClientToTarget = switchClientToTargetMock;
    TmuxRuntimeManager.prototype.refreshStatus = () => undefined as any;
    TmuxRuntimeManager.prototype.sendFocusIn = sendFocusInMock;

    try {
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(
        `${base}/control/open-dashboard?currentClientSession=aimux-repo-abc-client-12345678&clientTty=%2Fdev%2Fttys001&currentWindowId=%4042&focus=true`,
      );
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(true);
      expect(res.ok).toBe(true);
      expect(replaceWindowWhenReadyMock).not.toHaveBeenCalled();
      expect(setSessionOptionMock).toHaveBeenCalledWith("aimux-repo-abc", "@aimux-dashboard-build", expect.any(String));
      expect(setWindowOptionMock).toHaveBeenCalledWith(
        expect.objectContaining({ windowId: "@99" }),
        "@aimux-dashboard-build",
        expect.any(String),
      );
      expect(setWindowOptionMock).toHaveBeenCalledWith(
        expect.objectContaining({ windowId: "@99" }),
        TMUX_DASHBOARD_OWNER_OPTION,
        getRuntimeOwnerId(),
      );

      const snapshot = JSON.parse(
        readFileSync(getDashboardClientUiStatePath("aimux-repo-abc-client-12345678"), "utf-8"),
      ) as Record<string, unknown>;
      expect(snapshot).toMatchObject({
        screen: "dashboard",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        level: "sessions",
        selectedEntryKind: "session",
        selectedEntryId: "codex-1",
      });

      const coordinationRes = await fetch(
        `${base}/control/open-dashboard?clientTty=%2Fdev%2Fttys001&focus=true&screen=coordination`,
      );
      const coordinationBody = (await coordinationRes.json()) as { ok: boolean };
      expect(coordinationRes.ok).toBe(true);
      expect(coordinationBody.ok).toBe(true);
      expect(setSessionOptionMock).toHaveBeenCalledWith("aimux-repo-abc", "@aimux-dashboard-build", expect.any(String));
      const coordinationSnapshot = JSON.parse(
        readFileSync(getDashboardClientUiStatePath("aimux-repo-abc-client-12345678"), "utf-8"),
      ) as Record<string, unknown>;
      expect(coordinationSnapshot.screen).toBe("coordination");

      TmuxRuntimeManager.prototype.isWindowAlive = (target) => target.windowId !== "@42";
      const deadRes = await fetch(
        `${base}/control/open-dashboard?currentClientSession=aimux-repo-abc-client-12345678&clientTty=%2Fdev%2Fttys001&currentWindowId=%4042&focus=true`,
      );
      const deadBody = (await deadRes.json()) as { ok: boolean };
      expect(deadRes.ok).toBe(true);
      expect(deadBody.ok).toBe(true);
      const deadSnapshot = JSON.parse(
        readFileSync(getDashboardClientUiStatePath("aimux-repo-abc-client-12345678"), "utf-8"),
      ) as Record<string, unknown>;
      expect(deadSnapshot).toMatchObject({ screen: "dashboard" });
      expect(deadSnapshot.focusedWorktreePath).toBeUndefined();
      expect(deadSnapshot.level).toBeUndefined();
      expect(deadSnapshot.selectedEntryKind).toBeUndefined();
      expect(deadSnapshot.selectedEntryId).toBeUndefined();

      TmuxRuntimeManager.prototype.isWindowAlive = () => true;
      const liveAgainRes = await fetch(
        `${base}/control/open-dashboard?currentClientSession=aimux-repo-abc-client-12345678&clientTty=%2Fdev%2Fttys001&currentWindowId=%4042&focus=true`,
      );
      expect(liveAgainRes.ok).toBe(true);
      setWindowOptionMock.mockClear();
      replaceWindowWhenReadyMock.mockClear();
      switchClientToTargetMock.mockClear();
      sendFocusInMock.mockClear();
      dashboardReadyStamp = "pending-ready";
      readyPollsBeforeReady = 0;
      const staleReadyRes = await fetch(
        `${base}/control/open-dashboard?currentClientSession=aimux-repo-abc-client-12345678&clientTty=%2Fdev%2Fttys001&currentWindowId=%4042&focus=true`,
      );
      expect(staleReadyRes.ok).toBe(true);
      expect(readyPollsBeforeReady).toBeGreaterThan(1);
      expect(replaceWindowWhenReadyMock).toHaveBeenCalledWith(
        expect.objectContaining({ windowId: "@99" }),
        expect.any(Object),
        expect.any(Object),
      );
      const clearReadyCallIndex = setWindowOptionMock.mock.calls.findIndex(
        ([, key, value]) => key === TMUX_DASHBOARD_READY_OPTION && value === "",
      );
      expect(clearReadyCallIndex).toBe(-1);
      expect(switchClientToTargetMock).toHaveBeenCalledOnce();
      expect(sendFocusInMock).toHaveBeenCalledOnce();
      TmuxRuntimeManager.prototype.isWindowAlive = () => false;
      const dashboardWindowRes = await fetch(
        `${base}/control/open-dashboard?currentClientSession=aimux-repo-abc-client-12345678&clientTty=%2Fdev%2Fttys001&currentWindowId=%4099&focus=true`,
      );
      expect(dashboardWindowRes.ok).toBe(true);
      const dashboardWindowSnapshot = JSON.parse(
        readFileSync(getDashboardClientUiStatePath("aimux-repo-abc-client-12345678"), "utf-8"),
      ) as Record<string, unknown>;
      expect(dashboardWindowSnapshot).toMatchObject({
        screen: "dashboard",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        level: "sessions",
        selectedEntryKind: "session",
        selectedEntryId: "codex-1",
      });
    } finally {
      TmuxRuntimeManager.prototype.ensureProjectSession = ensureProjectSession;
      TmuxRuntimeManager.prototype.getProjectSession = getProjectSession;
      TmuxRuntimeManager.prototype.hasSession = hasSession;
      TmuxRuntimeManager.prototype.ensureDashboardWindow = ensureDashboardWindow;
      TmuxRuntimeManager.prototype.getWindowOption = getWindowOption;
      TmuxRuntimeManager.prototype.isWindowAlive = isWindowAlive;
      TmuxRuntimeManager.prototype.replaceWindowWhenReady = replaceWindowWhenReady;
      TmuxRuntimeManager.prototype.setSessionOption = setSessionOption;
      TmuxRuntimeManager.prototype.setWindowOption = setWindowOption;
      TmuxRuntimeManager.prototype.listProjectManagedWindows = listProjectManagedWindows;
      TmuxRuntimeManager.prototype.listClients = listClients;
      TmuxRuntimeManager.prototype.findClientByTty = findClientByTty;
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
        assigner: "coder",
        reviewOf: "codex-1",
        iteration: 1,
      }),
    });
    const review = (await reviewRes.json()) as {
      task: { id: string; assigner?: string; reviewStatus?: string; reviewOf?: string; iteration?: number };
    };
    expect(reviewRes.ok).toBe(true);
    expect(review.task).toMatchObject({
      assigner: "coder",
      reviewStatus: "pending",
      reviewOf: "codex-1",
      iteration: 1,
    });

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
        assigner: "coder",
        reviewOf: "codex-1",
        iteration: 0,
      }),
    });
    const review2 = (await reviewRes2.json()) as { task: { id: string; iteration?: number } };
    expect(review2.task.iteration).toBe(1);

    const changesRes = await fetch(`${base}/reviews/request-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: review2.task.id, from: "codex-1", body: "Please tighten the tests." }),
    });
    const changes = (await changesRes.json()) as {
      task: { reviewStatus: string };
      followUpTask?: { id: string; assignee?: string };
    };
    expect(changesRes.ok).toBe(true);
    expect(changes.task.reviewStatus).toBe("changes_requested");
    expect(changes.followUpTask?.id).toBeTruthy();
    expect(changes.followUpTask?.assignee).toBe("coder");

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

  it("returns on acceptance: the input route does not block on submit confirmation", async () => {
    const calls: Array<{ sessionId: string; text: string; waitForSubmit?: boolean }> = [];
    server?.stop();
    server = new MetadataServer({
      lifecycle: {
        sendAgentInput: (input) => {
          calls.push(input);
          return { sessionId: input.sessionId, accepted: true };
        },
      },
    });
    await server.start();

    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/live-pane/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1", text: "write me a poem" }),
    });
    expect(res.ok).toBe(true);
    // Output is delivered over SSE, so the route returns as soon as the input is
    // accepted and confirms the tmux submit in the background.
    expect(calls).toEqual([{ sessionId: "codex-1", text: "write me a poem", waitForSubmit: false }]);
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

  it("rejects malformed events stream startLine values", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const res = await fetch(`${base}/events?sessionId=codex-1&startLine=10.5`);
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "startLine must be an integer" });
  });

  it("streams project_update invalidations over SSE after API mutations", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    upsertNotification({ title: "Needs review", body: "Please inspect", sessionId: "codex-1" });

    const streamRes = await fetch(`${base}/events`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("event: project_update"));
    const readRes = await fetch(`${base}/notifications/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "codex-1" }),
    });
    expect(readRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: project_update");
    expect(text).toContain('"views":');
    expect(text).toContain('"coordination-worklist"');
    expect(text).toContain('"notifications"');
  });

  it("mutates notification id batches over one HTTP request", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const first = upsertNotification({ title: "First", body: "sessionless first" });
    const second = upsertNotification({ title: "Second", body: "sessionless second" });
    upsertNotification({ title: "Third", body: "kept unread" });

    const readRes = await fetch(`${base}/notifications/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [first.id, second.id] }),
    });
    const readBody = (await readRes.json()) as { ok: boolean; updated: number };
    expect(readRes.ok).toBe(true);
    expect(readBody).toEqual({ ok: true, updated: 2 });

    const listRes = await fetch(`${base}/notifications?unread=1`);
    const listed = (await listRes.json()) as { unreadCount: number };
    expect(listed.unreadCount).toBe(1);
  });

  it("rejects malformed notification id batches without mutating everything", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    upsertNotification({ title: "First", body: "still unread" });
    upsertNotification({ title: "Second", body: "also unread" });

    const readRes = await fetch(`${base}/notifications/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: "not-an-array" }),
    });
    const readBody = (await readRes.json()) as { ok: boolean; error: string };
    expect(readRes.status).toBe(400);
    expect(readBody).toEqual({ ok: false, error: "ids must be an array of strings" });

    const listRes = await fetch(`${base}/notifications?unread=1`);
    const listed = (await listRes.json()) as { unreadCount: number };
    expect(listed.unreadCount).toBe(2);
  });

  it("streams project_update invalidations after notification mutations", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    for (const pathname of ["/notifications/read", "/notifications/clear"]) {
      upsertNotification({
        title: `Please inspect ${pathname}.`,
        body: "notification mutation",
        sessionId: "codex-1",
      });

      const streamRes = await fetch(`${base}/events`);
      expect(streamRes.ok).toBe(true);
      expect(streamRes.body).toBeTruthy();

      const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("event: project_update"));
      const readRes = await fetch(`${base}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "codex-1" }),
      });
      expect(readRes.ok).toBe(true);

      const text = await streamRead;
      expect(text).toContain("event: project_update");
      expect(text).toContain('"coordination-worklist"');
      expect(text).toContain('"notifications"');
      expect(text).not.toContain('"inbox"');
    }
  });

  it("streams view-scoped invalidations after plan mutations", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("event: project_update"));
    const putRes = await fetch(`${base}/plans/codex-1`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Plan\n" }),
    });
    expect(putRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: project_update");
    expect(text).toContain('"plans"');
    expect(text).not.toContain('"notifications"');
    expect(text).not.toContain('"agents"');
  });

  it("streams workflow invalidations after thread mutations", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("event: project_update"));
    const threadRes = await fetch(`${base}/threads/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Coordinate",
        from: "codex-1",
        participants: ["claude-1"],
      }),
    });
    expect(threadRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: project_update");
    expect(text).toContain('"coordination-worklist"');
    expect(text).toContain('"project-observability"');
    expect(text).toContain('"tasks"');
    expect(text).toContain('"threads"');
    expect(text).not.toContain('"notifications"');
  });

  it("streams runtime invalidations after runtime mutations", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const streamRes = await fetch(`${base}/events`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("event: project_update"));
    const statusRes = await fetch(`${base}/set-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "codex-1", text: "Busy" }),
    });
    expect(statusRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain("event: project_update");
    expect(text).toContain('"agents"');
    expect(text).toContain('"coordination-worklist"');
    expect(text).toContain('"desktop-state"');
    expect(text).toContain('"project-observability"');
    expect(text).toContain('"topology"');
    expect(text).toContain('"worktrees"');
    expect(text).not.toContain('"notifications"');
    expect(text).not.toContain('"plans"');
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

    await vi.waitFor(
      () => {
        const derived = loadMetadataState(repoRoot).sessions["shell-1"]?.derived;
        expect(derived?.activity).toBe("running");
        expect(derived?.attention).toBe("normal");
        expect(derived?.unseenCount).toBe(0);
        expect(derived?.shellCommand).toBe("yarn devp");
        expect(derived?.shellCommandState).toBe("running");
      },
      { timeout: 2_500 },
    );

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

    await vi.waitFor(
      () => {
        const derived = loadMetadataState(repoRoot).sessions["shell-1"]?.derived;
        expect(derived?.activity).toBe("idle");
        expect(derived?.attention).toBe("normal");
        expect(derived?.shellCommand).toBe("yarn devp");
        expect(derived?.shellCommandState).toBe("prompt");
      },
      { timeout: 2_500 },
    );
  });

  it("suppresses the next prompt shell-state report when a service stop marker exists", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;
    const suppressDir = join(getProjectStateDir(), "shell-state-suppress");
    mkdirSync(suppressDir, { recursive: true });
    writeFileSync(join(suppressDir, "shell-1"), "stop");

    const promptRes = await fetch(`${base}/shell-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: "prompt",
        sessionId: "shell-1",
        tool: "shell",
      }),
    });
    const body = await promptRes.json();

    expect(promptRes.status).toBe(202);
    expect(body).toMatchObject({ ok: true, suppressed: true, sessionId: "shell-1", state: "prompt" });
    await vi.waitFor(() => {
      expect(loadMetadataState(repoRoot).sessions["shell-1"]).toBeUndefined();
    });
  });

  it("rejects malformed shell-state payloads before queueing", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const invalidState = await fetch(`${base}/shell-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "done", sessionId: "shell-1", tool: "shell" }),
    });
    const missingSession = await fetch(`${base}/shell-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "prompt", tool: "shell" }),
    });

    expect(invalidState.status).toBe(400);
    expect(missingSession.status).toBe(400);
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

  it("emits routed thread alerts to resolved callback recipients", async () => {
    server?.stop();
    server = new MetadataServer({
      threads: {
        sendMessage: (input) => ({
          thread: { id: "thread-1", worktreePath: input.worktreePath },
          message: {
            id: "message-1",
            threadId: "thread-1",
            ts: new Date().toISOString(),
            from: input.from ?? "user",
            to: ["codex-1"],
            kind: input.kind ?? "request",
            body: input.body,
          },
          threadCreated: true,
        }),
      },
    });
    await server.start();

    const endpoint = server.getAddress();
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
        from: "user",
        assignee: "reviewer",
        kind: "request",
        body: "Please inspect the role-routed branch.",
      }),
    });
    expect(sendRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain('"kind":"message_waiting"');
    expect(text).toContain('"sessionId":"codex-1"');
    expect(text).not.toContain('"sessionId":"reviewer"');
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

  it("emits task blocked alerts to the original assigner", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const taskRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Audit the blocked alert branch",
        type: "task",
      }),
    });
    const assigned = (await taskRes.json()) as { task: { id: string } };
    expect(taskRes.ok).toBe(true);

    const streamRes = await fetch(`${base}/events?sessionId=claude-lead`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("Task blocked:"));

    const blockRes = await fetch(`${base}/tasks/block`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: assigned.task.id,
        from: "codex-1",
        body: "Need a fixture.",
      }),
    });
    expect(blockRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain('"kind":"blocked"');
    expect(text).toContain('"sessionId":"claude-lead"');
  });

  it("emits task done alerts to the original assigner", async () => {
    const endpoint = server?.getAddress();
    expect(endpoint).toBeTruthy();
    const base = `http://${endpoint!.host}:${endpoint!.port}`;

    const taskRes = await fetch(`${base}/tasks/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "claude-lead",
        to: "codex-1",
        description: "Audit the done alert branch",
        type: "task",
      }),
    });
    const assigned = (await taskRes.json()) as { task: { id: string } };
    expect(taskRes.ok).toBe(true);

    const streamRes = await fetch(`${base}/events?sessionId=claude-lead`);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.body).toBeTruthy();

    const streamRead = readSseUntil(streamRes.body!, (text) => text.includes("Task done:"));

    const completeRes = await fetch(`${base}/tasks/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: assigned.task.id,
        from: "codex-1",
        body: "Done.",
      }),
    });
    expect(completeRes.ok).toBe(true);

    const text = await streamRead;
    expect(text).toContain('"kind":"task_done"');
    expect(text).toContain('"sessionId":"claude-lead"');
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

  it("returns library documents and renderer entries over HTTP", async () => {
    server?.stop();
    server = new MetadataServer({
      desktop: {
        getSessionDisplayContext: (sessionId) => (sessionId === "codex-plan" ? { label: "Codex plan" } : undefined),
      },
    });
    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    writeFileSync(join(repoRoot, "AGENTS.md"), "# Instructions\n");
    writeFileSync(
      join(getPlansDir(), "codex-plan.md"),
      "---\nupdatedAt: 2026-06-20T00:00:00.000Z\n---\n# Plan\n\nShip the API library.",
    );

    try {
      await server.start();
      const endpoint = server?.getAddress();
      expect(endpoint).toBeTruthy();
      const base = `http://${endpoint!.host}:${endpoint!.port}`;

      const res = await fetch(`${base}/library`);
      const body = (await res.json()) as {
        documents: Array<{ id: string; content: string }>;
        entries: Array<{ id: string; title: string; kind: string; preview: string }>;
      };

      expect(res.status).toBe(200);
      expect(body.documents).toEqual([expect.objectContaining({ id: "AGENTS.md", content: "# Instructions\n" })]);
      expect(body.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "doc:AGENTS.md", kind: "doc" }),
          expect.objectContaining({
            id: "plan:codex-plan",
            title: "Codex plan",
            kind: "plan",
            preview: "# Plan\n\nShip the API library.",
          }),
        ]),
      );
    } finally {
      process.chdir(previousCwd);
    }
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

    await vi.waitFor(() => expect(listNotifications({ projectRoot: repoRoot })).toHaveLength(1), {
      timeout: 2_500,
    });
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
