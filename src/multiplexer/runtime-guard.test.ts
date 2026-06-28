import { beforeEach, describe, expect, it, vi } from "vitest";

import { getProjectStateDirFor } from "../paths.js";
import { getProjectServiceManifest } from "../project-service-manifest.js";
import { AIMUX_TMUX_RUNTIME_CONTRACT_VERSION } from "../runtime-owner.js";
import { buildDashboardRuntimeGuardOverlayOutput } from "../tui/screens/overlay-renderers.js";
import { handleActiveDashboardOverlayKey, handleRuntimeGuardKey } from "./dashboard-control.js";
import {
  evaluateRuntimeGuard,
  probeRuntimeGuard,
  runtimeGuardEquals,
  runtimeGuardKeyDisposition,
  runtimeGuardOverlayCopy,
  stabilizeRuntimeGuardProbe,
  type RuntimeGuardState,
} from "./runtime-guard.js";

const loadMetadataEndpointMock = vi.hoisted(() => vi.fn());
const requestJsonMock = vi.hoisted(() => vi.fn());
const tmuxMock = vi.hoisted(() => ({
  isAvailable: vi.fn(() => false),
  getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-111" })),
  listSessionNames: vi.fn(() => ["aimux-repo-111"]),
  getSessionOption: vi.fn(() => null),
}));

vi.mock("../metadata-store.js", () => ({
  loadMetadataEndpoint: loadMetadataEndpointMock,
}));

vi.mock("../http-client.js", () => ({
  requestJson: requestJsonMock,
  isHttpTimeoutError: (error: unknown) => (error as { code?: unknown })?.code === "ETIMEDOUT",
}));

vi.mock("../tmux/runtime-manager.js", () => ({
  TmuxRuntimeManager: vi.fn(function () {
    return tmuxMock;
  }),
}));

const liveManifest = getProjectServiceManifest();
const repoProjectStateDir = getProjectStateDirFor("/repo");

beforeEach(() => {
  loadMetadataEndpointMock.mockReset();
  requestJsonMock.mockReset();
  tmuxMock.isAvailable.mockReset();
  tmuxMock.getProjectSession.mockReset();
  tmuxMock.listSessionNames.mockReset();
  tmuxMock.getSessionOption.mockReset();
  tmuxMock.isAvailable.mockReturnValue(false);
  tmuxMock.getProjectSession.mockReturnValue({ sessionName: "aimux-repo-111" });
  tmuxMock.listSessionNames.mockReturnValue(["aimux-repo-111"]);
  tmuxMock.getSessionOption.mockReturnValue(null);
});

describe("evaluateRuntimeGuard", () => {
  it("flags self-drift above everything, even when the service matches", () => {
    expect(evaluateRuntimeGuard({ selfDrift: true, endpointPresent: true, serviceManifest: liveManifest })).toEqual({
      kind: "stale",
      reason: "self-drift",
    });
  });

  it("reports disconnected when there is no endpoint", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: false, serviceManifest: null })).toEqual({
      kind: "disconnected",
    });
  });

  it("reports disconnected when the service is unreachable", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: "unreachable" })).toEqual({
      kind: "disconnected",
    });
  });

  it("reports disconnected when an endpoint is present but no manifest came back", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: null })).toEqual({
      kind: "disconnected",
    });
  });

  it("reports stale when a live endpoint belongs to the wrong service identity", () => {
    expect(
      evaluateRuntimeGuard({
        selfDrift: false,
        endpointPresent: true,
        serviceManifest: liveManifest,
        serviceIdentityMismatch: true,
      }),
    ).toEqual({ kind: "stale", reason: "service-mismatch" });
  });

  it("reports ok when the live service manifest matches ours", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: liveManifest })).toEqual({
      kind: "ok",
    });
  });

  it("reports runtime rebuild required before service health failures", () => {
    expect(
      evaluateRuntimeGuard({
        selfDrift: false,
        runtimeRebuildRequired: true,
        endpointPresent: false,
        serviceManifest: null,
      }),
    ).toEqual({ kind: "runtime-rebuild-required" });
  });

  it("flags a service-mismatch when build stamps differ", () => {
    expect(
      evaluateRuntimeGuard({
        selfDrift: false,
        endpointPresent: true,
        serviceManifest: { ...liveManifest, buildStamp: `${liveManifest.buildStamp}-other` },
      }),
    ).toEqual({ kind: "stale", reason: "service-mismatch" });
  });
});

describe("runtimeGuardEquals", () => {
  it("matches identical states and distinguishes stale reasons", () => {
    expect(runtimeGuardEquals({ kind: "ok" }, { kind: "ok" })).toBe(true);
    expect(runtimeGuardEquals({ kind: "disconnected" }, { kind: "disconnected" })).toBe(true);
    expect(runtimeGuardEquals({ kind: "runtime-rebuild-required" }, { kind: "runtime-rebuild-required" })).toBe(true);
    expect(runtimeGuardEquals({ kind: "ok" }, { kind: "disconnected" })).toBe(false);
    expect(runtimeGuardEquals({ kind: "stale", reason: "self-drift" }, { kind: "stale", reason: "self-drift" })).toBe(
      true,
    );
    expect(
      runtimeGuardEquals({ kind: "stale", reason: "self-drift" }, { kind: "stale", reason: "service-mismatch" }),
    ).toBe(false);
  });
});

describe("stabilizeRuntimeGuardProbe", () => {
  it("keeps an ok dashboard unguarded for one missed disconnected probe", () => {
    expect(stabilizeRuntimeGuardProbe({ kind: "ok" }, { kind: "disconnected" }, 0)).toEqual({
      state: { kind: "ok" },
      disconnectedProbeCount: 1,
    });
  });

  it("reports disconnected after repeated misses", () => {
    expect(stabilizeRuntimeGuardProbe({ kind: "ok" }, { kind: "disconnected" }, 1)).toEqual({
      state: { kind: "disconnected" },
      disconnectedProbeCount: 2,
    });
  });

  it("resets the missed-probe count on ok or stale probes", () => {
    expect(stabilizeRuntimeGuardProbe({ kind: "ok" }, { kind: "ok" }, 1)).toEqual({
      state: { kind: "ok" },
      disconnectedProbeCount: 0,
    });
    expect(stabilizeRuntimeGuardProbe({ kind: "ok" }, { kind: "stale", reason: "service-mismatch" }, 1)).toEqual({
      state: { kind: "stale", reason: "service-mismatch" },
      disconnectedProbeCount: 0,
    });
  });

  it("does not replace stale with disconnected until repeated misses", () => {
    expect(
      stabilizeRuntimeGuardProbe({ kind: "stale", reason: "service-mismatch" }, { kind: "disconnected" }, 0),
    ).toEqual({
      state: { kind: "stale", reason: "service-mismatch" },
      disconnectedProbeCount: 1,
    });
  });
});

describe("runtimeGuardKeyDisposition", () => {
  it("passes safe nav keys and swallows repair/action keys", () => {
    expect(runtimeGuardKeyDisposition("R")).toBe("swallow");
    expect(runtimeGuardKeyDisposition("r")).toBe("swallow");
    expect(runtimeGuardKeyDisposition("B")).toBe("swallow");
    expect(runtimeGuardKeyDisposition("b")).toBe("swallow");
    for (const key of ["up", "down", "j", "k", "tab", "?", "q"]) {
      expect(runtimeGuardKeyDisposition(key)).toBe("passthrough");
    }
    // Screen-switch letters mutate on their subscreens (e.g. "c" = clear-all) → swallowed.
    for (const key of ["c", "d", "p", "l", "t", "g", "n", "x", "f", "enter", "1"]) {
      expect(runtimeGuardKeyDisposition(key)).toBe("swallow");
    }
  });
});

describe("runtimeGuardOverlayCopy", () => {
  it("gives each non-ok state a distinct, non-empty title", () => {
    const titles = (["self-drift", "service-mismatch"] as const).map(
      (reason) => runtimeGuardOverlayCopy({ kind: "stale", reason }).title,
    );
    titles.push(runtimeGuardOverlayCopy({ kind: "disconnected" }).title);
    titles.push(runtimeGuardOverlayCopy({ kind: "runtime-rebuild-required" }).title);
    expect(new Set(titles).size).toBe(4);
    expect(titles.every((t) => t.length > 0)).toBe(true);
    expect(runtimeGuardOverlayCopy({ kind: "ok" }).title).toBe("");
  });
});

describe("probeRuntimeGuard", () => {
  it("reports ok only when endpoint and health pids match", async () => {
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "ok" });
  });

  it("reports stale when health belongs to a different project state dir", async () => {
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: "/tmp/other-project", serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "stale", reason: "service-mismatch" });
  });

  it("reports stale when health comes from a different pid", async () => {
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 9999, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "stale", reason: "service-mismatch" });
  });

  it("reports stale when health omits service info", async () => {
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "stale", reason: "service-mismatch" });
  });

  it("keeps the guard ok when a busy local service misses the health timeout", async () => {
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockRejectedValue(
      Object.assign(new Error("request timed out after 2500ms"), { code: "ETIMEDOUT" }),
    );

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "ok" });
  });

  it("reports disconnected when the local service socket is gone", async () => {
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:45123"), {
        code: "ECONNREFUSED",
      }),
    );

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "disconnected" });
  });

  it("reports disconnected when the local service connect times out", async () => {
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockRejectedValue(
      Object.assign(new Error("connect ETIMEDOUT 127.0.0.1:45123"), {
        code: "ETIMEDOUT",
      }),
    );

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "disconnected" });
  });

  it("reports runtime rebuild required from tmux marker", async () => {
    tmuxMock.isAvailable.mockReturnValue(true);
    tmuxMock.getSessionOption.mockImplementation((_sessionName: string, key: string) =>
      key === "@aimux-runtime-rebuild-required" ? "1" : AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
    );
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "runtime-rebuild-required" });
    expect(tmuxMock.getSessionOption).toHaveBeenCalledWith("aimux-repo-111", "@aimux-runtime-rebuild-required");
  });

  it("reports runtime rebuild required from a stale host contract without a rebuild marker", async () => {
    tmuxMock.isAvailable.mockReturnValue(true);
    tmuxMock.getSessionOption.mockImplementation((_sessionName: string, key: string) => {
      if (key === "@aimux-runtime-rebuild-required") return "0";
      if (key === "@aimux-runtime-contract") return "legacy-contract";
      return null;
    });
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "runtime-rebuild-required" });
  });

  it("reports runtime rebuild required from a missing client contract without a rebuild marker", async () => {
    tmuxMock.isAvailable.mockReturnValue(true);
    tmuxMock.listSessionNames.mockReturnValue(["aimux-repo-111", "aimux-repo-111-client-deadbeef"]);
    tmuxMock.getSessionOption.mockImplementation((sessionName: string, key: string) => {
      if (key === "@aimux-runtime-rebuild-required") return "0";
      if (key === "@aimux-project-root") return "/repo";
      if (key === "@aimux-host-session" && sessionName === "aimux-repo-111-client-deadbeef") return "aimux-repo-111";
      if (key === "@aimux-runtime-contract" && sessionName === "aimux-repo-111-client-deadbeef") return null;
      if (key === "@aimux-runtime-contract") return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    });
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "runtime-rebuild-required" });
    expect(tmuxMock.getSessionOption).toHaveBeenCalledWith("aimux-repo-111-client-deadbeef", "@aimux-runtime-contract");
  });

  it("ignores fresh client sessions until they advertise the host and project root", async () => {
    tmuxMock.isAvailable.mockReturnValue(true);
    tmuxMock.listSessionNames.mockReturnValue(["aimux-repo-111", "aimux-repo-111-client-deadbeef"]);
    tmuxMock.getSessionOption.mockImplementation((sessionName: string, key: string) => {
      if (key === "@aimux-runtime-rebuild-required") return "0";
      if (key === "@aimux-project-root" && sessionName === "aimux-repo-111") return "/repo";
      if (key === "@aimux-runtime-contract" && sessionName === "aimux-repo-111-client-deadbeef") return null;
      if (key === "@aimux-runtime-contract") return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    });
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "ok" });
    expect(tmuxMock.getSessionOption).not.toHaveBeenCalledWith(
      "aimux-repo-111-client-deadbeef",
      "@aimux-runtime-contract",
    );
  });

  it("ignores client sessions from another project root for runtime rebuild checks", async () => {
    tmuxMock.isAvailable.mockReturnValue(true);
    tmuxMock.listSessionNames.mockReturnValue(["aimux-repo-111", "aimux-repo-111-client-deadbeef"]);
    tmuxMock.getSessionOption.mockImplementation((sessionName: string, key: string) => {
      if (key === "@aimux-runtime-rebuild-required") return "0";
      if (key === "@aimux-project-root" && sessionName === "aimux-repo-111") return "/repo";
      if (key === "@aimux-host-session" && sessionName === "aimux-repo-111-client-deadbeef") return "aimux-repo-111";
      if (key === "@aimux-project-root" && sessionName === "aimux-repo-111-client-deadbeef") return "/other";
      if (key === "@aimux-runtime-contract" && sessionName === "aimux-repo-111-client-deadbeef") return null;
      if (key === "@aimux-runtime-contract") return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    });
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "ok" });
    expect(tmuxMock.getSessionOption).not.toHaveBeenCalledWith(
      "aimux-repo-111-client-deadbeef",
      "@aimux-runtime-contract",
    );
  });

  it("ignores malformed client-like sessions for runtime rebuild checks", async () => {
    tmuxMock.isAvailable.mockReturnValue(true);
    tmuxMock.listSessionNames.mockReturnValue(["aimux-repo-111", "aimux-repo-111-client-stale"]);
    tmuxMock.getSessionOption.mockImplementation((sessionName: string, key: string) => {
      if (key === "@aimux-runtime-rebuild-required") return "0";
      if (key === "@aimux-runtime-contract" && sessionName === "aimux-repo-111-client-stale") return null;
      if (key === "@aimux-runtime-contract") return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    });
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "ok" });
    expect(tmuxMock.getSessionOption).not.toHaveBeenCalledWith(
      "aimux-repo-111-client-stale",
      "@aimux-runtime-contract",
    );
  });

  it("does not require runtime rebuild when the tmux host session is absent", async () => {
    tmuxMock.isAvailable.mockReturnValue(true);
    tmuxMock.listSessionNames.mockReturnValue([]);
    loadMetadataEndpointMock.mockReturnValue({
      host: "127.0.0.1",
      port: 45123,
      pid: 1234,
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    requestJsonMock.mockResolvedValue({
      status: 200,
      json: { ok: true, pid: 1234, projectStateDir: repoProjectStateDir, serviceInfo: liveManifest },
    });

    await expect(probeRuntimeGuard("/repo")).resolves.toEqual({ kind: "ok" });
    expect(tmuxMock.getSessionOption).not.toHaveBeenCalled();
  });
});

describe("buildDashboardRuntimeGuardOverlayOutput", () => {
  it("renders nothing when ok and an overlay carrying the title otherwise", () => {
    expect(buildDashboardRuntimeGuardOverlayOutput({ runtimeGuardState: { kind: "ok" } }, 120, 40)).toBeNull();
    const out = buildDashboardRuntimeGuardOverlayOutput({ runtimeGuardState: { kind: "disconnected" } }, 120, 40);
    expect(out?.toLowerCase()).toContain("reconnecting");
    const rebuild = buildDashboardRuntimeGuardOverlayOutput(
      { runtimeGuardState: { kind: "runtime-rebuild-required" } },
      120,
      40,
    );
    expect(rebuild?.toLowerCase()).toContain("repairing");
    expect(rebuild).not.toContain("rebuild runtime");
    expect(rebuild).not.toContain("detach");
  });
});

describe("handleRuntimeGuardKey", () => {
  function stubHost(state: RuntimeGuardState) {
    return {
      mode: "dashboard",
      runtimeGuardState: state,
      dashboardBusyState: null,
      dashboardErrorState: null,
      dashboardOverlayState: { kind: "none" },
      dashboardState: {
        screen: "dashboard",
        level: "sessions",
        sessionIndex: 0,
        worktreeEntries: [{ kind: "session", id: "codex-1" }],
        worktreeSessions: [{ id: "codex-1", status: "ready" }],
        worktreeNavOrder: [undefined],
      },
      tmuxRuntimeManager: { listProjectManagedWindows: vi.fn() },
      footerFlash: "",
      footerFlashTicks: 0,
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [{ id: "codex-1", status: "ready" }]),
      renderCurrentDashboardView: vi.fn(),
    };
  }

  it("does not intercept when the guard is ok", () => {
    const host = stubHost({ kind: "ok" });
    expect(handleRuntimeGuardKey(host, Buffer.from("n"))).toBe(false);
  });

  it("swallows a mutating key and flashes when guarded", () => {
    const host = stubHost({ kind: "stale", reason: "self-drift" });
    expect(handleRuntimeGuardKey(host, Buffer.from("n"))).toBe(true);
    expect(host.footerFlash).toContain("repairing");
  });

  it("swallows a mutating key without claiming repair while disconnected", () => {
    const host = stubHost({ kind: "disconnected" });
    expect(handleRuntimeGuardKey(host, Buffer.from("n"))).toBe(true);
    expect(host.footerFlash).toContain("reconnecting");
    expect(host.footerFlash).not.toContain("repairing");
  });

  it("lets a safe nav key through when guarded", () => {
    const host = stubHost({ kind: "disconnected" });
    expect(handleRuntimeGuardKey(host, Buffer.from("k"))).toBe(false);
  });

  it("lets quit through while guarded", () => {
    const host = stubHost({ kind: "runtime-rebuild-required" });
    expect(handleRuntimeGuardKey(host, Buffer.from("q"))).toBe(false);
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("lets Enter focus a live local tmux agent while guarded", () => {
    const host = stubHost({ kind: "disconnected" });
    expect(handleRuntimeGuardKey(host, Buffer.from("\r"))).toBe(false);
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("swallows lowercase library hotkey while guarded on the dashboard", () => {
    const host = stubHost({ kind: "disconnected" });
    expect(handleRuntimeGuardKey(host, Buffer.from("l"))).toBe(true);
    expect(host.footerFlash).toContain("reconnecting");
  });

  it("keeps Enter blocked for offline sessions because they resume through the API", () => {
    const host = stubHost({ kind: "disconnected" });
    host.dashboardState.worktreeSessions = [{ id: "codex-1", status: "offline" }];
    host.getDashboardSessions = vi.fn(() => [{ id: "codex-1", status: "offline" }]);
    expect(handleRuntimeGuardKey(host, Buffer.from("\r"))).toBe(true);
    expect(host.footerFlash).toContain("reconnecting");
  });

  it("keeps Enter blocked for offline sessions on ungrouped dashboards", () => {
    const host = stubHost({ kind: "disconnected" });
    host.dashboardState.worktreeNavOrder = [];
    host.dashboardState.worktreeEntries = [];
    host.dashboardState.worktreeSessions = [];
    host.getDashboardSessions = vi.fn(() => [{ id: "codex-1", status: "offline" }]);
    expect(handleRuntimeGuardKey(host, Buffer.from("\r"))).toBe(true);
  });

  it("keeps dashboard hotkeys blocked on subscreens while guarded", () => {
    const host = stubHost({ kind: "disconnected" });
    host.dashboardState.screen = "project";
    expect(handleRuntimeGuardKey(host, Buffer.from("l"))).toBe(true);
  });

  it("lets Escape use dashboard-local back/focus navigation while guarded", () => {
    const host = stubHost({ kind: "disconnected" });
    expect(handleRuntimeGuardKey(host, Buffer.from("\x1b"))).toBe(false);
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("swallows R when guarded because repair is automatic", () => {
    const host = stubHost({ kind: "stale", reason: "service-mismatch" });
    expect(handleRuntimeGuardKey(host, Buffer.from("R"))).toBe(true);
    expect(host.footerFlash).toContain("repairing");
  });

  it("swallows B when guarded because repair is automatic", () => {
    const host = stubHost({ kind: "runtime-rebuild-required" });
    expect(handleRuntimeGuardKey(host, Buffer.from("B"))).toBe(true);
    expect(host.footerFlash).toContain("repairing");
  });

  it("lets active busy/error overlays own keys before the guard", () => {
    const host = stubHost({ kind: "stale", reason: "service-mismatch" });
    host.dashboardErrorState = { title: "Failed", lines: ["boom"] };
    expect(handleRuntimeGuardKey(host, Buffer.from("n"))).toBe(false);
  });

  it("lets active input overlays own keys before the guard", () => {
    const host = stubHost({ kind: "stale", reason: "service-mismatch" });
    host.dashboardOverlayState = { kind: "orchestration-input" };
    expect(handleRuntimeGuardKey(host, Buffer.from("hello"))).toBe(false);
  });

  it("lets busy overlays yield to live local tmux focus only", () => {
    const host = stubHost({ kind: "runtime-rebuild-required" });
    host.runtimeGuardRepairBusy = true;
    host.dashboardBusyState = { title: "Repairing Aimux", lines: [], spinnerFrame: 0, startedAt: Date.now() };

    expect(handleActiveDashboardOverlayKey(host, Buffer.from("\r"))).toBe(false);
    expect(handleActiveDashboardOverlayKey(host, Buffer.from("n"))).toBe(true);

    host.runtimeGuardRepairBusy = false;
    host.dashboardBusyState = {
      title: "Aimux is reconnecting",
      lines: ["Aimux is reconnecting the project service."],
      spinnerFrame: 0,
      startedAt: Date.now(),
    };

    expect(handleActiveDashboardOverlayKey(host, Buffer.from("\r"))).toBe(false);
    expect(handleActiveDashboardOverlayKey(host, Buffer.from("n"))).toBe(true);
  });
});
