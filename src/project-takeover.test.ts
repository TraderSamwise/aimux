import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "./http-client.js";
import { getProjectIdFor } from "./paths.js";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("./http-client.js", () => ({
  requestJson: vi.fn(async () => ({ status: 200, json: { ok: true } })),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

let tmpHome = "";
let livePids = new Set<number>();

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("project takeover", () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "aimux-takeover-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("AIMUX_HOME", join(tmpHome, ".aimux-custom"));
    livePids = new Set([1001, 2001, 2002]);
    vi.mocked(requestJson).mockClear();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "lsof") return `p${args[2]}\nfcwd\nn${join(tmpHome, "repo-a")}\n`;
      return `node /opt/aimux/dist/main.js __project-service-internal --project-id ${getProjectIdFor(
        join(tmpHome, "repo-a"),
      )} --project-root ${join(tmpHome, "repo-a")}`;
    });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      const numericPid = Number(pid);
      if (!livePids.has(numericPid)) throw new Error(`pid ${numericPid} not alive`);
      if (signal && signal !== 0) livePids.delete(numericPid);
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("stops only the matching project service in the default aimux home", async () => {
    const { takeOverProjectFromOtherOwners } = await import("./project-takeover.js");
    const projectRoot = join(tmpHome, "repo-a");
    const otherProjectRoot = join(tmpHome, "repo-b");
    const projectId = getProjectIdFor(projectRoot);
    const otherProjectId = getProjectIdFor(otherProjectRoot);
    const defaultHome = join(tmpHome, ".aimux");
    const projectStateDir = join(defaultHome, "projects", projectId);

    mkdirSync(join(defaultHome, "daemon"), { recursive: true });
    mkdirSync(projectStateDir, { recursive: true });
    writeJson(join(defaultHome, "daemon", "daemon.json"), { pid: 1001, port: 43190 });
    writeJson(join(defaultHome, "daemon", "state.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        [projectId]: { pid: 2001, projectRoot },
        [otherProjectId]: { pid: 2002, projectRoot: otherProjectRoot },
      },
    });
    writeJson(join(projectStateDir, "metadata-api.json"), { host: "127.0.0.1", port: 43190 });
    writeFileSync(join(projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43190\n");
    writeJson(join(projectStateDir, "host.json"), { legacy: true });

    await takeOverProjectFromOtherOwners(projectRoot);

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledWith("http://127.0.0.1:43190/projects/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { projectRoot },
      timeoutMs: 1500,
    });
    const state = JSON.parse(readFileSync(join(defaultHome, "daemon", "state.json"), "utf-8")) as {
      projects: Record<string, unknown>;
    };
    expect(state.projects[projectId]).toBeUndefined();
    expect(state.projects[otherProjectId]).toBeTruthy();
    expect(existsSync(join(projectStateDir, "metadata-api.json"))).toBe(false);
    expect(existsSync(join(projectStateDir, "metadata-api.txt"))).toBe(false);
    expect(existsSync(join(projectStateDir, "host.json"))).toBe(true);
    expect(livePids.has(2002)).toBe(true);
  });

  it("preserves the default owner topology while clearing stale connection files", async () => {
    const { takeOverProjectFromOtherOwners } = await import("./project-takeover.js");
    const projectRoot = join(tmpHome, "repo-a");
    const projectId = getProjectIdFor(projectRoot);
    const defaultHome = join(tmpHome, ".aimux");
    const projectStateDir = join(defaultHome, "projects", projectId);
    const topologyPath = join(projectStateDir, "runtime-topology.yaml");
    const topology = "version: 1\nsessions:\n  - id: codex-custom\n    status: offline\n";

    mkdirSync(join(defaultHome, "daemon"), { recursive: true });
    mkdirSync(projectStateDir, { recursive: true });
    writeJson(join(defaultHome, "daemon", "daemon.json"), { pid: 1001, port: 43190 });
    writeJson(join(defaultHome, "daemon", "state.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        [projectId]: { pid: 2001, projectRoot },
      },
    });
    writeFileSync(topologyPath, topology);
    writeJson(join(projectStateDir, "metadata-api.json"), { host: "127.0.0.1", port: 43190 });
    writeFileSync(join(projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43190\n");

    await takeOverProjectFromOtherOwners(projectRoot);

    expect(readFileSync(topologyPath, "utf-8")).toBe(topology);
    expect(existsSync(join(projectStateDir, "metadata-api.json"))).toBe(false);
    expect(existsSync(join(projectStateDir, "metadata-api.txt"))).toBe(false);
  });

  it("does not signal a stale pid that is not an aimux project service", async () => {
    const { takeOverProjectFromOtherOwners } = await import("./project-takeover.js");
    const projectRoot = join(tmpHome, "repo-a");
    const projectId = getProjectIdFor(projectRoot);
    const defaultHome = join(tmpHome, ".aimux");

    vi.mocked(requestJson).mockRejectedValueOnce(new Error("other daemon unavailable"));
    execFileSyncMock.mockReturnValue("sleep 999");
    mkdirSync(join(defaultHome, "daemon"), { recursive: true });
    writeJson(join(defaultHome, "daemon", "daemon.json"), { pid: 1001, port: 43190 });
    writeJson(join(defaultHome, "daemon", "state.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        [projectId]: { pid: 2001, projectRoot },
      },
    });

    await takeOverProjectFromOtherOwners(projectRoot);

    expect(livePids.has(2001)).toBe(true);
    const state = JSON.parse(readFileSync(join(defaultHome, "daemon", "state.json"), "utf-8")) as {
      projects: Record<string, unknown>;
    };
    expect(state.projects[projectId]).toBeUndefined();
  });

  it("accepts legacy project service pids only when cwd matches the project", async () => {
    const { takeOverProjectFromOtherOwners } = await import("./project-takeover.js");
    const projectRoot = join(tmpHome, "repo-a");
    const projectId = getProjectIdFor(projectRoot);
    const defaultHome = join(tmpHome, ".aimux");

    vi.mocked(requestJson).mockRejectedValueOnce(new Error("other daemon unavailable"));
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "lsof") return `p${args[2]}\nfcwd\nn${projectRoot}\n`;
      return "node /opt/aimux/dist/main.js __project-service-internal";
    });
    mkdirSync(join(defaultHome, "daemon"), { recursive: true });
    writeJson(join(defaultHome, "daemon", "daemon.json"), { pid: 1001, port: 43190 });
    writeJson(join(defaultHome, "daemon", "state.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        [projectId]: { pid: 2001, projectRoot },
      },
    });

    await takeOverProjectFromOtherOwners(projectRoot);

    expect(livePids.has(2001)).toBe(false);
    expect(process.kill).toHaveBeenCalledWith(2001, "SIGTERM");
  });
});
