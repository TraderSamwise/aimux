import { describe, expect, it, vi } from "vitest";
import { buildRuntimeCoherenceReport, renderRuntimeCoherenceReport } from "./runtime-coherence.js";
import type { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import type { ProjectServiceManifest } from "./project-service-manifest.js";
import type { MetadataApiEndpoint } from "./metadata-store.js";
import {
  AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
  TMUX_DASHBOARD_OWNER_OPTION,
  TMUX_RUNTIME_CONTRACT_OPTION,
  TMUX_RUNTIME_OWNER_OPTION,
} from "./runtime-owner.js";

const expectedManifest: ProjectServiceManifest = {
  apiVersion: 4,
  capabilities: { parsedAgentOutput: true },
  buildStamp: "service-new",
};

function createTmux(overrides: Partial<TmuxRuntimeManager> = {}): TmuxRuntimeManager {
  const tmux = {
    isAvailable: vi.fn(() => true),
    getVersion: vi.fn(() => "tmux 3.5a"),
    listSessionNames: vi.fn(() => ["aimux-alpha-111", "aimux-alpha-111-client-deadbeef", "aimux-beta-222"]),
    isManagedSessionName: vi.fn((sessionName: string) => sessionName.startsWith("aimux-")),
    getProjectSession: vi.fn((projectRoot: string) => ({
      projectRoot,
      projectId: projectRoot.endsWith("alpha") ? "111" : "222",
      sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
    })),
    getSessionOption: vi.fn((sessionName: string, key: string) => {
      if (key === "@aimux-project-root" && sessionName.startsWith("aimux-alpha-111")) return "/repo/alpha";
      if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
      if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
      if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    }),
    listWindows: vi.fn((sessionName: string) => {
      if (sessionName === "aimux-alpha-111") return [{ id: "@1", index: 0, name: "dashboard", active: true }];
      if (sessionName === "aimux-alpha-111-client-deadbeef") {
        return [{ id: "@1", index: 0, name: "dashboard", active: true }];
      }
      if (sessionName === "aimux-beta-222") return [{ id: "@2", index: 0, name: "dashboard", active: true }];
      return [];
    }),
    isWindowAlive: vi.fn(() => true),
    displayMessage: vi.fn(() => "node /current/dist/main.js --tmux-dashboard-internal"),
    getWindowOption: vi.fn((target: { windowId: string }, key: string) => {
      if (key === "@aimux-dashboard-build") return target.windowId === "@1" ? "dashboard-old" : "dashboard-new";
      if (key === TMUX_DASHBOARD_OWNER_OPTION) return "owner-new";
      return null;
    }),
    ...overrides,
  };
  return tmux as unknown as TmuxRuntimeManager;
}

describe("runtime coherence report", () => {
  it("reports service and dashboard version mismatches across known projects", async () => {
    const requestJson = vi.fn(async (url: string) => {
      if (url.includes("43211")) {
        return {
          status: 200,
          json: { ok: true, pid: 1001, serviceInfo: { ...expectedManifest, buildStamp: "service-old" } },
        };
      }
      return { status: 200, json: { ok: true, pid: 1002, serviceInfo: expectedManifest } };
    });
    const endpointFor = (projectRoot?: string): MetadataApiEndpoint | null =>
      projectRoot === "/repo/alpha"
        ? { host: "127.0.0.1", port: 43211, pid: 1001, updatedAt: "2026-06-20T00:00:00.000Z" }
        : { host: "127.0.0.1", port: 43212, pid: 1002, updatedAt: "2026-06-20T00:00:00.000Z" };

    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux(),
      now: () => new Date("2026-06-20T00:00:00.000Z"),
      loadDaemonInfo: () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }),
      loadDaemonState: () => ({
        projects: {
          alpha: {
            projectId: "alpha",
            projectRoot: "/repo/alpha",
            pid: 1001,
            startedAt: "then",
            updatedAt: "now",
          },
        },
      }),
      loadMetadataEndpoint: endpointFor,
      requestJson,
      getDashboardBuildStamp: () => "dashboard-new",
      getProjectServiceManifest: () => expectedManifest,
      getRuntimeOwnerId: () => "owner-new",
    });

    expect(report.summary).toEqual({ projects: 2, ok: 1, needsRestart: 1, runtimeRebuildRequired: 0 });
    expect(report.projects.map((project) => project.projectRoot)).toEqual(["/repo/alpha", "/repo/beta"]);
    expect(report.projects[0]?.sources).toEqual(["daemon-state", "tmux"]);
    expect(report.projects[0]?.service.status).toBe("mismatch");
    expect(report.projects[0]?.dashboards).toHaveLength(1);
    expect(report.projects[0]?.dashboards[0]?.status).toBe("mismatch");
    expect(report.projects[1]?.status).toBe("ok");
  });

  it("keeps unreachable services visible in the versions report", async () => {
    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux({
        listSessionNames: vi.fn(() => []),
      } as Partial<TmuxRuntimeManager>),
      loadDaemonInfo: () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }),
      loadDaemonState: () => ({
        projects: {
          alpha: {
            projectId: "alpha",
            projectRoot: "/repo/alpha",
            pid: 1001,
            startedAt: "then",
            updatedAt: "now",
          },
        },
      }),
      loadMetadataEndpoint: () => ({
        host: "127.0.0.1",
        port: 43211,
        pid: 1001,
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
      requestJson: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      getDashboardBuildStamp: () => "dashboard-new",
      getProjectServiceManifest: () => expectedManifest,
      getRuntimeOwnerId: () => "owner-new",
    });

    expect(report.projects[0]?.service.status).toBe("unreachable");
    expect(report.projects[0]?.service.error).toBe("connection refused");
    expect(renderRuntimeCoherenceReport(report)).toContain("service: unreachable");
  });

  it("retries a slow health probe before marking a service unreachable", async () => {
    const requestJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("request timed out after 1000ms"))
      .mockResolvedValueOnce({
        status: 200,
        json: { ok: true, pid: 1001, serviceInfo: expectedManifest },
      });

    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux({
        listSessionNames: vi.fn(() => []),
      } as Partial<TmuxRuntimeManager>),
      loadDaemonInfo: () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }),
      loadDaemonState: () => ({
        projects: {
          alpha: {
            projectId: "alpha",
            projectRoot: "/repo/alpha",
            pid: 1001,
            startedAt: "then",
            updatedAt: "now",
          },
        },
      }),
      loadMetadataEndpoint: () => ({
        host: "127.0.0.1",
        port: 43211,
        pid: 1001,
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
      requestJson,
      getDashboardBuildStamp: () => "dashboard-new",
      getProjectServiceManifest: () => expectedManifest,
      getRuntimeOwnerId: () => "owner-new",
    });

    expect(requestJson).toHaveBeenNthCalledWith(1, "http://127.0.0.1:43211/health", { timeoutMs: 1000 });
    expect(requestJson).toHaveBeenNthCalledWith(2, "http://127.0.0.1:43211/health", { timeoutMs: 4000 });
    expect(report.projects[0]?.service.status).toBe("ok");
  });

  it("marks dashboards stale when the tmux runtime owner differs", async () => {
    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux({
        listSessionNames: vi.fn(() => ["aimux-beta-222"]),
        getSessionOption: vi.fn((sessionName: string, key: string) => {
          if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
          if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-old";
          if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
          return null;
        }),
      } as Partial<TmuxRuntimeManager>),
      loadDaemonInfo: () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }),
      loadDaemonState: () => ({
        projects: {
          beta: {
            projectId: "beta",
            projectRoot: "/repo/beta",
            pid: 1002,
            startedAt: "then",
            updatedAt: "now",
          },
        },
      }),
      loadMetadataEndpoint: () => ({
        host: "127.0.0.1",
        port: 43212,
        pid: 1002,
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
      requestJson: vi.fn(async () => ({
        status: 200,
        json: { ok: true, pid: 1002, serviceInfo: expectedManifest },
      })),
      getDashboardBuildStamp: () => "dashboard-new",
      getProjectServiceManifest: () => expectedManifest,
      getRuntimeOwnerId: () => "owner-new",
    });

    expect(report.summary).toEqual({ projects: 1, ok: 0, needsRestart: 1, runtimeRebuildRequired: 0 });
    expect(report.projects[0]?.status).toBe("needs-restart");
    expect(report.projects[0]?.dashboards[0]?.status).toBe("mismatch");
    expect(renderRuntimeCoherenceReport(report)).toContain("runtimeOwner=owner-old");
  });

  it("reports an explicit tmux runtime contract mismatch as requiring runtime rebuild", async () => {
    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux({
        listSessionNames: vi.fn(() => ["aimux-beta-222"]),
        getSessionOption: vi.fn((sessionName: string, key: string) => {
          if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
          if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
          if (key === TMUX_RUNTIME_CONTRACT_OPTION) return "legacy-contract";
          return null;
        }),
      } as Partial<TmuxRuntimeManager>),
      loadDaemonInfo: () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }),
      loadDaemonState: () => ({
        projects: {
          beta: {
            projectId: "beta",
            projectRoot: "/repo/beta",
            pid: 1002,
            startedAt: "then",
            updatedAt: "now",
          },
        },
      }),
      loadMetadataEndpoint: () => ({
        host: "127.0.0.1",
        port: 43212,
        pid: 1002,
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
      requestJson: vi.fn(async () => ({
        status: 200,
        json: { ok: true, pid: 1002, serviceInfo: expectedManifest },
      })),
      getDashboardBuildStamp: () => "dashboard-new",
      getProjectServiceManifest: () => expectedManifest,
      getRuntimeOwnerId: () => "owner-new",
    });

    expect(report.summary).toEqual({ projects: 1, ok: 0, needsRestart: 1, runtimeRebuildRequired: 1 });
    expect(report.projects[0]?.runtime).toMatchObject({
      contract: "legacy-contract",
      expectedContract: AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
      rebuildRequired: true,
    });
    expect(renderRuntimeCoherenceReport(report)).toContain("runtime: contract=legacy-contract expected=1 rebuild=yes");
  });

  it("reports stale client tmux runtime contracts as requiring runtime rebuild", async () => {
    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux({
        listSessionNames: vi.fn(() => ["aimux-beta-222", "aimux-beta-222-client-stale"]),
        getSessionOption: vi.fn((sessionName: string, key: string) => {
          if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
          if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
          if (key === TMUX_RUNTIME_CONTRACT_OPTION && sessionName === "aimux-beta-222-client-stale") {
            return "legacy-contract";
          }
          if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
          return null;
        }),
      } as Partial<TmuxRuntimeManager>),
      loadDaemonInfo: () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }),
      loadDaemonState: () => ({
        projects: {
          beta: {
            projectId: "beta",
            projectRoot: "/repo/beta",
            pid: 1002,
            startedAt: "then",
            updatedAt: "now",
          },
        },
      }),
      loadMetadataEndpoint: () => ({
        host: "127.0.0.1",
        port: 43212,
        pid: 1002,
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
      requestJson: vi.fn(async () => ({
        status: 200,
        json: { ok: true, pid: 1002, serviceInfo: expectedManifest },
      })),
      getDashboardBuildStamp: () => "dashboard-new",
      getProjectServiceManifest: () => expectedManifest,
      getRuntimeOwnerId: () => "owner-new",
    });

    expect(report.summary).toEqual({ projects: 1, ok: 0, needsRestart: 1, runtimeRebuildRequired: 1 });
    expect(report.projects[0]?.runtime).toMatchObject({
      contract: AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
      expectedContract: AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
      rebuildRequired: true,
      clientSessions: [
        {
          sessionName: "aimux-beta-222-client-stale",
          contract: "legacy-contract",
          rebuildRequired: true,
        },
      ],
    });
    expect(renderRuntimeCoherenceReport(report)).toContain(
      "client: aimux-beta-222-client-stale contract=legacy-contract expected=1 rebuild=yes",
    );
  });

  it("reports missing client tmux runtime contracts as requiring runtime rebuild", async () => {
    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux({
        listSessionNames: vi.fn(() => ["aimux-beta-222", "aimux-beta-222-client-missing"]),
        getSessionOption: vi.fn((sessionName: string, key: string) => {
          if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
          if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
          if (key === TMUX_RUNTIME_CONTRACT_OPTION && sessionName === "aimux-beta-222-client-missing") return null;
          if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
          return null;
        }),
      } as Partial<TmuxRuntimeManager>),
      loadDaemonInfo: () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }),
      loadDaemonState: () => ({
        projects: {
          beta: {
            projectId: "beta",
            projectRoot: "/repo/beta",
            pid: 1002,
            startedAt: "then",
            updatedAt: "now",
          },
        },
      }),
      loadMetadataEndpoint: () => ({
        host: "127.0.0.1",
        port: 43212,
        pid: 1002,
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
      requestJson: vi.fn(async () => ({
        status: 200,
        json: { ok: true, pid: 1002, serviceInfo: expectedManifest },
      })),
      getDashboardBuildStamp: () => "dashboard-new",
      getProjectServiceManifest: () => expectedManifest,
      getRuntimeOwnerId: () => "owner-new",
    });

    expect(report.summary).toEqual({ projects: 1, ok: 0, needsRestart: 1, runtimeRebuildRequired: 1 });
    expect(report.projects[0]?.runtime.clientSessions).toEqual([
      {
        sessionName: "aimux-beta-222-client-missing",
        contract: null,
        rebuildRequired: true,
      },
    ]);
    expect(renderRuntimeCoherenceReport(report)).toContain(
      "client: aimux-beta-222-client-missing contract=(missing) expected=1 rebuild=yes",
    );
  });

  it("reports stale native paths in processes and hook commands", async () => {
    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux({
        listSessionNames: vi.fn(() => ["aimux-beta-222"]),
        displayMessage: vi.fn(() => "/opt/aimux/native/local-old/dist/main.js --tmux-dashboard-internal"),
      } as Partial<TmuxRuntimeManager>),
      loadDaemonInfo: () => ({ pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }),
      loadDaemonState: () => ({
        projects: {
          beta: {
            projectId: "beta",
            projectRoot: "/repo/beta",
            pid: 1002,
            startedAt: "then",
            updatedAt: "now",
          },
        },
      }),
      loadMetadataEndpoint: () => ({
        host: "127.0.0.1",
        port: 43212,
        pid: 1002,
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
      requestJson: vi.fn(async () => ({
        status: 200,
        json: { ok: true, pid: 1002, serviceInfo: expectedManifest },
      })),
      readProcessArgs: vi.fn((pid: number) =>
        pid === 9001
          ? "/opt/aimux/native/local-current/bin/aimux daemon run"
          : "/opt/aimux/native/local-old/dist/main.js __project-service-internal",
      ),
      listProcessArgs: vi.fn(() => [
        {
          pid: 77,
          args: "/Users/sam/.volta/bin/claude --settings command='/opt/aimux/native/local-old/dist/main.js' claude-hook stop --project /repo/alpha",
        },
      ]),
      getAimuxCliLaunchCommand: vi.fn(() => ({
        command: "/opt/aimux/bin/aimux",
        args: [],
        source: "stable-shim",
        currentEntryPath: "/opt/aimux/native/local-current/dist/main.js",
        stableShimPath: "/opt/aimux/bin/aimux",
      })),
      getDashboardBuildStamp: () => "dashboard-new",
      getProjectServiceManifest: () => expectedManifest,
      getRuntimeOwnerId: () => "owner-new",
    });

    expect(report.daemon.process?.staleNativePath).toBe(false);
    expect(report.projects[0]?.service.process?.staleNativePath).toBe(true);
    expect(report.projects[0]?.dashboards[0]?.process?.staleNativePath).toBe(true);
    expect(report.staleHookProcesses).toHaveLength(1);
    expect(report.staleHookProcesses[0]?.projectRoot).toBe("/repo/alpha");
    expect(renderRuntimeCoherenceReport(report)).toContain("Stale hook processes: 1");
  });
});
