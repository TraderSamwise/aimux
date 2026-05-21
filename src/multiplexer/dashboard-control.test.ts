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
