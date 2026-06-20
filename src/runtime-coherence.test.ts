import { describe, expect, it, vi } from "vitest";
import { buildRuntimeCoherenceReport, renderRuntimeCoherenceReport } from "./runtime-coherence.js";
import type { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import type { ProjectServiceManifest } from "./project-service-manifest.js";
import type { MetadataApiEndpoint } from "./metadata-store.js";
import { TMUX_DASHBOARD_OWNER_OPTION, TMUX_RUNTIME_OWNER_OPTION } from "./runtime-owner.js";

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

    expect(report.summary).toEqual({ projects: 2, ok: 1, needsRestart: 1 });
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

  it("marks dashboards stale when the tmux runtime owner differs", async () => {
    const report = await buildRuntimeCoherenceReport({
      tmux: createTmux({
        listSessionNames: vi.fn(() => ["aimux-beta-222"]),
        getSessionOption: vi.fn((sessionName: string, key: string) => {
          if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
          if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-old";
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

    expect(report.summary).toEqual({ projects: 1, ok: 0, needsRestart: 1 });
    expect(report.projects[0]?.status).toBe("needs-restart");
    expect(report.projects[0]?.dashboards[0]?.status).toBe("mismatch");
    expect(renderRuntimeCoherenceReport(report)).toContain("runtimeOwner=owner-old");
  });
});
