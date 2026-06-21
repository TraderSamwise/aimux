import { describe, expect, it, vi, beforeEach } from "vitest";
import { getProjectServiceManifest } from "../project-service-manifest.js";

const mocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
  loadMetadataEndpoint: vi.fn(),
  removeMetadataEndpoint: vi.fn(),
  ensureDaemonRunning: vi.fn(),
  ensureProjectService: vi.fn(),
  stopProjectService: vi.fn(),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

vi.mock("../http-client.js", () => ({
  requestJson: mocks.requestJson,
}));

vi.mock("../metadata-store.js", () => ({
  loadMetadataState: vi.fn(() => ({ sessions: {} })),
  loadMetadataEndpoint: mocks.loadMetadataEndpoint,
  removeMetadataEndpoint: mocks.removeMetadataEndpoint,
}));

vi.mock("../daemon.js", () => ({
  ensureDaemonRunning: mocks.ensureDaemonRunning,
  ensureProjectService: mocks.ensureProjectService,
  stopProjectService: mocks.stopProjectService,
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

describe("postToProjectService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadMetadataEndpoint.mockReturnValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    mocks.ensureDaemonRunning.mockResolvedValue({ pid: 1, port: 43190 });
    mocks.ensureProjectService.mockResolvedValue({ projectId: "repo", projectRoot: process.cwd(), pid: 2 });
    mocks.stopProjectService.mockResolvedValue({ projectId: "repo", projectRoot: process.cwd(), pid: 2 });
  });

  it("recovers from a stale refused project-service endpoint", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:43444"), { code: "ECONNREFUSED" });
    mocks.requestJson
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() } })
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true } });
    const { postToProjectService } = await import("./dashboard-control.js");

    const result = await postToProjectService({ dashboardServiceRecovery: null }, "/agents/resume", {
      sessionId: "claude-1",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-retryable HTTP failures", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 409, json: { ok: false, error: "already exists" } });
    const { postToProjectService } = await import("./dashboard-control.js");

    await expect(
      postToProjectService({ dashboardServiceRecovery: null }, "/agents/spawn", { sessionId: "claude-1" }),
    ).rejects.toThrow("already exists");

    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson).toHaveBeenCalledTimes(2);
  });

  it("recovers before requesting when endpoint health reports a different pid", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 99, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 1 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 1,
    });

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
  });

  it("recovers before requesting when endpoint health reports a stale manifest", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({
        status: 200,
        json: { ok: true, pid: 2, serviceInfo: { ...getProjectServiceManifest(), buildStamp: "old" } },
      })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 2 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 2,
    });

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
  });

  it("recovers before requesting when endpoint health omits the pid", async () => {
    mocks.requestJson
      .mockResolvedValueOnce({ status: 200, json: { ok: true, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 5 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 5,
    });

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
  });

  it("does not restart the project service after one transient health failure", async () => {
    mocks.requestJson
      .mockRejectedValueOnce(new Error("request timed out after 250ms"))
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 3 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 3,
    });

    expect(mocks.stopProjectService).not.toHaveBeenCalled();
    expect(mocks.removeMetadataEndpoint).not.toHaveBeenCalled();
    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
  });

  it("recovers before requesting when endpoint health is connection-refused", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:43444"), { code: "ECONNREFUSED" });
    mocks.requestJson
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ status: 200, json: { ok: true, pid: 2, serviceInfo: getProjectServiceManifest() } })
      .mockResolvedValueOnce({ status: 200, json: { ok: true, value: 4 } });
    const { getFromProjectService } = await import("./dashboard-control.js");

    await expect(getFromProjectService({ dashboardServiceRecovery: null }, "/desktop-state")).resolves.toEqual({
      ok: true,
      value: 4,
    });

    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.stopProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(3);
  });

  it("bounds control-plane recovery by the project-service request timeout", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadMetadataEndpoint.mockReturnValue(null);
      mocks.ensureDaemonRunning.mockImplementation(() => new Promise(() => {}));
      const { postToProjectService } = await import("./dashboard-control.js");

      const request = postToProjectService(
        { dashboardServiceRecovery: null },
        "/agents/resume",
        { sessionId: "claude-1" },
        { timeoutMs: 25 },
      );
      const rejection = expect(request).rejects.toThrow("project service recovery timed out");
      await vi.advanceTimersByTimeAsync(30);

      await rejection;
      expect(mocks.requestJson).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dashboard live target activation", () => {
  it("opens agents through the project-service control API in dashboard mode", async () => {
    const { waitAndOpenLiveTmuxWindowForEntry } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn((format: string) => (format === "#{client_tty}" ? "/dev/live" : "@9")),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForEntry(host, { id: "codex-1" }, 1200)).resolves.toBe("opened");

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/control/open-notification-target",
      {
        sessionId: "codex-1",
        focus: true,
        currentClientSession: "aimux-repo-client-live",
        clientTty: "/dev/live",
        currentWindowId: "@9",
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(host.postToProjectService.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(1200);
  });

  it("opens services through the project-service control API in dashboard mode", async () => {
    const { waitAndOpenLiveTmuxWindowForService } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      postToProjectService: vi.fn(async () => ({ ok: true })),
      tmuxRuntimeManager: {
        currentClientSession: vi.fn(() => "aimux-repo-client-live"),
        displayMessage: vi.fn(() => undefined),
      },
      showDashboardError: vi.fn(),
    };

    await expect(waitAndOpenLiveTmuxWindowForService(host, "service-1", 1200)).resolves.toBe("opened");

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/control/open-notification-target",
      {
        sessionId: "service-1",
        focus: true,
        currentClientSession: "aimux-repo-client-live",
        clientTty: undefined,
        currentWindowId: undefined,
      },
      { timeoutMs: expect.any(Number) },
    );
    expect(host.postToProjectService.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(1200);
  });
});

describe("showOrchestrationRoutePicker", () => {
  it("loads route options from the project service in dashboard mode", async () => {
    const { showOrchestrationRoutePicker } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      dashboardState: {
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [],
        worktreeSessions: [],
        worktreeNavOrder: [],
      },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [{ id: "codex-1" }]),
      getFromProjectService: vi.fn(async () => ({
        ok: true,
        options: [
          {
            label: "Role: reviewer [1: codex-1]",
            assignee: "reviewer",
            worktreePath: "/repo/.aimux/worktrees/demo",
            recipientIds: ["codex-1"],
          },
        ],
      })),
      openDashboardOverlay: vi.fn(),
      renderOrchestrationRoutePicker: vi.fn(),
      showDashboardError: vi.fn(),
    };

    showOrchestrationRoutePicker(host, "task");
    await vi.waitFor(() => expect(host.renderOrchestrationRoutePicker).toHaveBeenCalledOnce());

    expect(host.getFromProjectService).toHaveBeenCalledWith(
      "/orchestration/routes?mode=task&selectedSessionId=codex-1&worktreePath=%2Frepo%2F.aimux%2Fworktrees%2Fdemo",
    );
    expect(host.orchestrationRouteMode).toBe("task");
    expect(host.orchestrationRouteOptions).toEqual([
      {
        label: "Role: reviewer [1: codex-1]",
        assignee: "reviewer",
        worktreePath: "/repo/.aimux/worktrees/demo",
        recipientIds: ["codex-1"],
      },
    ]);
    expect(host.openDashboardOverlay).toHaveBeenCalledWith("orchestration-route-picker");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("rejects malformed service route option payloads before opening the picker", async () => {
    const { showOrchestrationRoutePicker } = await import("./dashboard-control.js");
    const host: any = {
      mode: "dashboard",
      dashboardState: { worktreeEntries: [], worktreeSessions: [], worktreeNavOrder: [] },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => []),
      getFromProjectService: vi.fn(async () => ({ ok: true, options: [{ recipientIds: "codex-1" }] })),
      openDashboardOverlay: vi.fn(),
      renderOrchestrationRoutePicker: vi.fn(),
      showDashboardError: vi.fn(),
    };

    showOrchestrationRoutePicker(host, "message");
    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalledOnce());

    expect(host.openDashboardOverlay).not.toHaveBeenCalled();
    expect(host.renderOrchestrationRoutePicker).not.toHaveBeenCalled();
  });
});

describe("reloadDashboardFromGuard", () => {
  it("uses PATH aimux for dashboard reloads", async () => {
    const { reloadDashboardFromGuard } = await import("./dashboard-control.js");
    const originalArgv = process.argv[1];
    process.argv[1] = "/Users/sam/cs/aimux/dist/main.js";
    const host = { footerFlash: "", footerFlashTicks: 0, renderCurrentDashboardView: vi.fn() };

    try {
      reloadDashboardFromGuard(host as never);
    } finally {
      process.argv[1] = originalArgv;
    }

    expect(mocks.spawn).toHaveBeenCalledWith("aimux", ["dashboard-reload", "--open"], {
      detached: true,
      stdio: "ignore",
    });
  });

  it("shows a footer failure when the reload child emits an error", async () => {
    let onError: (() => void) | undefined;
    mocks.spawn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "error") onError = handler;
      }),
      unref: vi.fn(),
    });
    const { reloadDashboardFromGuard } = await import("./dashboard-control.js");
    const host = { footerFlash: "", footerFlashTicks: 0, renderCurrentDashboardView: vi.fn() };

    reloadDashboardFromGuard(host as never);
    onError?.();

    expect(host.footerFlash).toContain("Reload failed");
    expect(host.renderCurrentDashboardView).toHaveBeenCalledTimes(2);
  });

  it("uses PATH aimux instead of a versioned stable install path", async () => {
    const { resolveDashboardReloadCommand } = await import("./dashboard-control.js");
    const originalArgv = process.argv[1];
    process.argv[1] = "/Users/sam/.aimux/native/1.2.3/bin/aimux";

    try {
      expect(resolveDashboardReloadCommand()).toBe("aimux");
    } finally {
      process.argv[1] = originalArgv;
    }
  });
});

describe("restartRuntimeFromGuard", () => {
  it("uses PATH aimux for guarded runtime rebuilds", async () => {
    const { restartRuntimeFromGuard } = await import("./dashboard-control.js");
    const host = {
      projectRoot: "/repo/app",
      footerFlash: "",
      footerFlashTicks: 0,
      renderCurrentDashboardView: vi.fn(),
    };

    restartRuntimeFromGuard(host as never);

    expect(mocks.spawn).toHaveBeenCalledWith("aimux", ["restart-runtime", "--project-root", "/repo/app", "--open"], {
      detached: true,
      stdio: "ignore",
    });
  });

  it("shows a footer failure when the runtime rebuild child emits an error", async () => {
    let onError: (() => void) | undefined;
    mocks.spawn.mockReturnValueOnce({
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "error") onError = handler;
      }),
      unref: vi.fn(),
    });
    const { restartRuntimeFromGuard } = await import("./dashboard-control.js");
    const host = {
      projectRoot: "/repo/app",
      footerFlash: "",
      footerFlashTicks: 0,
      renderCurrentDashboardView: vi.fn(),
    };

    restartRuntimeFromGuard(host as never);
    onError?.();

    expect(host.footerFlash).toContain("Runtime rebuild failed");
    expect(host.renderCurrentDashboardView).toHaveBeenCalledTimes(2);
  });
});

describe("handleDashboardSubscreenNavigationKey", () => {
  function makeHost() {
    return {
      showCoordination: vi.fn(),
      renderCoordination: vi.fn(),
      showProject: vi.fn(),
      renderProject: vi.fn(),
      showLibrary: vi.fn(),
      renderLibrary: vi.fn(),
      showTopology: vi.fn(),
      renderTopology: vi.fn(),
      showGraveyard: vi.fn(),
      renderGraveyard: vi.fn(),
    };
  }

  it("maps leading-letter hotkeys to their screens (c/p/l/t/g)", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    const cases: Array<[string, keyof ReturnType<typeof makeHost>, string]> = [
      ["c", "showCoordination", "project"],
      ["p", "showProject", "coordination"],
      ["l", "showLibrary", "coordination"],
      ["t", "showTopology", "coordination"],
      ["g", "showGraveyard", "coordination"],
    ];
    for (const [key, method, otherScreen] of cases) {
      const host = makeHost();
      // currentScreen differs from target, so the show* (not render*) path runs.
      const handled = handleDashboardSubscreenNavigationKey(host as never, key, otherScreen as never);
      expect(handled).toBe(true);
      expect(host[method]).toHaveBeenCalledTimes(1);
    }
  });

  it("declines (returns false) when the hotkey matches the current screen, so the screen's own handler can act", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    // e.g. on coordination, [c] must reach the section handler (clear/complete), not re-nav.
    const cases: Array<[string, string, keyof ReturnType<typeof makeHost>]> = [
      ["c", "coordination", "showCoordination"],
      ["p", "project", "showProject"],
      ["l", "library", "showLibrary"],
      ["t", "topology", "showTopology"],
      ["g", "graveyard", "showGraveyard"],
    ];
    for (const [key, screen, showMethod] of cases) {
      const host = makeHost();
      expect(handleDashboardSubscreenNavigationKey(host as never, key, screen as never)).toBe(false);
      // Declining must not also fire the switch — the key belongs to the screen's own handler.
      expect(host[showMethod]).not.toHaveBeenCalled();
    }
  });

  it("no longer treats the retired i/y keys as navigation", async () => {
    const { handleDashboardSubscreenNavigationKey } = await import("./dashboard-control.js");
    for (const key of ["i", "y", "z"]) {
      const host = makeHost();
      expect(handleDashboardSubscreenNavigationKey(host as never, key, "graveyard")).toBe(false);
    }
  });
});
