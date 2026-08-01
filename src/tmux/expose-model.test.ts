import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastControlContext } from "../fast-control.js";
import type { ExposeConfig, ExposeScope } from "./expose-model.js";
import { focusExposeItem, initialExposeScope, loadExposeScopeItems, nextExposeScope } from "./expose-model.js";

vi.mock("../worktree.js", () => ({
  listWorktrees: vi.fn(() => [{ path: "/repo" }, { path: "/repo/.aimux/worktrees/feat-x" }]),
}));

const tempRoots: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function config(initialScope: ExposeScope): ExposeConfig {
  return { initialScope };
}

describe("nextExposeScope", () => {
  it("walks up the ladder", () => {
    expect(nextExposeScope("worktree")).toBe("project");
    expect(nextExposeScope("project")).toBe("global");
  });

  it("clamps at global", () => {
    expect(nextExposeScope("global")).toBe("global");
  });
});

describe("initialExposeScope", () => {
  const insideAgent: FastControlContext = { projectRoot: "/repo", currentWindow: "codex", currentWindowId: "@2" };

  it("starts at global when launched cross-project", () => {
    expect(initialExposeScope(true, insideAgent, config("worktree"))).toBe("global");
  });

  it("starts at worktree inside an agent window", () => {
    expect(initialExposeScope(false, insideAgent, config("worktree"))).toBe("worktree");
  });

  it("starts at project on the dashboard window", () => {
    expect(
      initialExposeScope(
        false,
        { projectRoot: "/repo", currentWindow: "dashboard", currentWindowId: "@9" },
        config("worktree"),
      ),
    ).toBe("project");
  });

  it("starts at the configured initial scope", () => {
    expect(initialExposeScope(false, insideAgent, config("project"))).toBe("project");
    expect(initialExposeScope(false, insideAgent, config("global"))).toBe("global");
  });

  it("starts at project when there is no current window id", () => {
    expect(initialExposeScope(false, { projectRoot: "/repo", currentWindow: "codex" }, config("worktree"))).toBe(
      "project",
    );
  });
});

describe("loadExposeScopeItems", () => {
  const context: FastControlContext = { projectRoot: "/repo", currentWindow: "codex", currentWindowId: "@2" };

  function createProjectStateDir(endpoint = "http://127.0.0.1:43191") {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-model-test-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "metadata-api.txt"), `${endpoint}\n`);
    tempRoots.push(root);
    return stateDir;
  }

  it("loads worktree scope from the project-service endpoint", async () => {
    const requestJsonFn = vi.fn(async () => ({
      status: 200,
      json: { ok: true, items: [{ id: "wt-agent" }] },
    }));
    const view = await loadExposeScopeItems("worktree", context, createProjectStateDir(), { requestJsonFn });
    const requested = new URL(requestJsonFn.mock.calls[0]![0]);
    expect(requested.pathname).toBe("/control/switchable-agents");
    expect(requested.searchParams.get("scope")).toBe("worktree");
    expect(requested.searchParams.get("labelFormat")).toBe("raw");
    expect(requested.searchParams.get("includePreview")).toBe("1");
    expect(requested.searchParams.get("currentWindowId")).toBe("@2");
    expect(view).toMatchObject({ scope: "worktree", scopeLabel: "this worktree", sublabel: "none" });
    expect(view.items.map((i) => i.id)).toEqual(["wt-agent"]);
  });

  it("preserves preview snapshots from the scope item API", async () => {
    const requestJsonFn = vi.fn(async () => ({
      status: 200,
      json: {
        ok: true,
        items: [
          {
            id: "wt-agent",
            previewSnapshot: {
              output: "warm output\n",
              capturedAt: "2026-07-20T13:00:00.000Z",
              source: "capture",
              windowId: "@2",
              startLine: -40,
              lineCount: 40,
            },
          },
        ],
      },
    }));
    const view = await loadExposeScopeItems("worktree", context, createProjectStateDir(), { requestJsonFn });

    expect(view.items[0]?.previewSnapshot).toEqual({
      output: "warm output\n",
      capturedAt: "2026-07-20T13:00:00.000Z",
      source: "capture",
      windowId: "@2",
      startLine: -40,
      lineCount: 40,
    });
  });

  it("loads project scope as all switchable project sessions", async () => {
    const requestJsonFn = vi.fn(async () => ({
      status: 200,
      json: { ok: true, items: [{ id: "project-agent" }] },
    }));
    const view = await loadExposeScopeItems("project", context, createProjectStateDir(), { requestJsonFn });
    const requested = new URL(requestJsonFn.mock.calls[0]![0]);
    expect(requested.searchParams.get("scope")).toBe("all");
    expect(requested.searchParams.get("includePreview")).toBe("1");
    expect(view).toMatchObject({ scope: "project", scopeLabel: "all worktrees", sublabel: "worktree" });
    expect(view.items.map((i) => i.id)).toEqual(["project-agent"]);
  });

  it("loads global scope from the daemon cross-project route", async () => {
    const requestJsonFn = vi.fn(async () => ({
      status: 200,
      json: { ok: true, items: [{ id: "global-agent" }] },
    }));
    const view = await loadExposeScopeItems("global", context, createProjectStateDir(), {
      daemonEndpoint: "http://127.0.0.1:43190",
      requestJsonFn,
    });
    const requested = new URL(requestJsonFn.mock.calls[0]![0]);
    expect(requested.pathname).toBe("/core/expose/items");
    expect(requested.searchParams.get("scope")).toBe(null);
    expect(requested.searchParams.get("includePreview")).toBe("1");
    expect(view).toMatchObject({ scope: "global", scopeLabel: "all projects", sublabel: "project-worktree" });
    expect(view.items.map((i) => i.id)).toEqual(["global-agent"]);
  });
});

describe("focusExposeItem", () => {
  const context: FastControlContext & { clientTty?: string } = {
    projectRoot: "/repo",
    currentClientSession: "aimux-repo-client-12345678",
    clientTty: "/dev/ttys001",
  };

  function createProjectStateDir(endpoint = "http://127.0.0.1:43191") {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-focus-test-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "metadata-api.txt"), `${endpoint}\n`);
    tempRoots.push(root);
    return stateDir;
  }

  it("focuses same-project tiles through the project-service route", async () => {
    const requestJsonFn = vi.fn(async () => ({
      status: 200,
      json: { ok: true },
    }));
    const ok = await focusExposeItem(
      { id: "a", label: "claude", target: { windowId: "@2" } } as never,
      context,
      createProjectStateDir(),
      { requestJsonFn },
    );
    const requested = new URL(requestJsonFn.mock.calls[0]![0]);
    const body = requestJsonFn.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect(ok).toBe(true);
    expect(requested.pathname).toBe("/control/focus-window");
    expect(body).toMatchObject({ windowId: "@2", currentClientSession: context.currentClientSession, focus: true });
    expect(body.clientTty).toBe(context.clientTty);
  });

  it("focuses cross-project tiles through the daemon route", async () => {
    const requestJsonFn = vi.fn(async () => ({
      status: 200,
      json: { ok: true },
    }));
    const ok = await focusExposeItem(
      { id: "a", label: "claude", projectRoot: "/other", target: { windowId: "@9" } } as never,
      context,
      createProjectStateDir(),
      { daemonEndpoint: "http://127.0.0.1:43190", requestJsonFn },
    );
    const requested = new URL(requestJsonFn.mock.calls[0]![0]);
    const body = requestJsonFn.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect(ok).toBe(true);
    expect(requested.pathname).toBe("/core/expose/focus");
    expect(body).toMatchObject({
      windowId: "@9",
      projectRoot: "/other",
      currentClientSession: context.currentClientSession,
    });
  });
});
