import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
  resolveProjectServiceEndpoint: vi.fn(),
  removeMetadataEndpoint: vi.fn(),
  ensureDaemonRunning: vi.fn(),
  ensureProjectService: vi.fn(),
}));

vi.mock("../http-client.js", () => ({
  requestJson: mocks.requestJson,
}));

vi.mock("../metadata-store.js", () => ({
  loadMetadataState: vi.fn(() => ({ sessions: {} })),
  resolveProjectServiceEndpoint: mocks.resolveProjectServiceEndpoint,
  removeMetadataEndpoint: mocks.removeMetadataEndpoint,
}));

vi.mock("../daemon.js", () => ({
  ensureDaemonRunning: mocks.ensureDaemonRunning,
  ensureProjectService: mocks.ensureProjectService,
}));

describe("postToProjectService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProjectServiceEndpoint.mockReturnValue({ host: "127.0.0.1", port: 43444 });
    mocks.ensureDaemonRunning.mockResolvedValue({ pid: 1, port: 43190 });
    mocks.ensureProjectService.mockResolvedValue({ projectId: "repo", projectRoot: process.cwd(), pid: 2 });
  });

  it("recovers from a stale refused project-service endpoint", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:43444"), { code: "ECONNREFUSED" });
    mocks.requestJson.mockRejectedValueOnce(refused).mockResolvedValueOnce({ status: 200, json: { ok: true } });
    const { postToProjectService } = await import("./dashboard-control.js");

    const result = await postToProjectService({ dashboardServiceRecovery: null }, "/agents/resume", {
      sessionId: "claude-1",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
    expect(mocks.ensureProjectService).toHaveBeenCalledWith(process.cwd());
    expect(mocks.requestJson).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable HTTP failures", async () => {
    mocks.requestJson.mockResolvedValueOnce({ status: 409, json: { ok: false, error: "already exists" } });
    const { postToProjectService } = await import("./dashboard-control.js");

    await expect(
      postToProjectService({ dashboardServiceRecovery: null }, "/agents/spawn", { sessionId: "claude-1" }),
    ).rejects.toThrow("already exists");

    expect(mocks.ensureProjectService).not.toHaveBeenCalled();
    expect(mocks.requestJson).toHaveBeenCalledTimes(1);
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
    for (const [key, screen] of [
      ["c", "coordination"],
      ["p", "project"],
      ["l", "library"],
      ["t", "topology"],
      ["g", "graveyard"],
    ] as const) {
      const host = makeHost();
      expect(handleDashboardSubscreenNavigationKey(host as never, key, screen as never)).toBe(false);
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
