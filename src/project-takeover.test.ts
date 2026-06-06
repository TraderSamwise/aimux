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
    vi.stubEnv("AIMUX_HOME", join(tmpHome, ".aimux"));
    livePids = new Set([1001, 2001, 2002]);
    vi.mocked(requestJson).mockClear();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue("node /opt/aimux/dist/main.js __project-service-internal");
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

  it("stops only the matching project service in the other aimux home", async () => {
    const { takeOverProjectFromOtherOwners } = await import("./project-takeover.js");
    const projectRoot = join(tmpHome, "repo-a");
    const otherProjectRoot = join(tmpHome, "repo-b");
    const projectId = getProjectIdFor(projectRoot);
    const otherProjectId = getProjectIdFor(otherProjectRoot);
    const devHome = join(tmpHome, ".aimux-dev");
    const projectStateDir = join(devHome, "projects", projectId);

    mkdirSync(join(devHome, "daemon"), { recursive: true });
    mkdirSync(projectStateDir, { recursive: true });
    writeJson(join(devHome, "daemon", "daemon.json"), { pid: 1001, port: 43191 });
    writeJson(join(devHome, "daemon", "state.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        [projectId]: { pid: 2001, projectRoot },
        [otherProjectId]: { pid: 2002, projectRoot: otherProjectRoot },
      },
    });
    writeJson(join(projectStateDir, "metadata-api.json"), { host: "127.0.0.1", port: 43191 });
    writeFileSync(join(projectStateDir, "metadata-api.txt"), "http://127.0.0.1:43191\n");

    await takeOverProjectFromOtherOwners(projectRoot);

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledWith("http://127.0.0.1:43191/projects/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { projectRoot },
      timeoutMs: 1500,
    });
    const state = JSON.parse(readFileSync(join(devHome, "daemon", "state.json"), "utf-8")) as {
      projects: Record<string, unknown>;
    };
    expect(state.projects[projectId]).toBeUndefined();
    expect(state.projects[otherProjectId]).toBeTruthy();
    expect(existsSync(join(projectStateDir, "metadata-api.json"))).toBe(false);
    expect(existsSync(join(projectStateDir, "metadata-api.txt"))).toBe(false);
    expect(livePids.has(2002)).toBe(true);
  });

  it("does not signal a stale pid that is not an aimux project service", async () => {
    const { takeOverProjectFromOtherOwners } = await import("./project-takeover.js");
    const projectRoot = join(tmpHome, "repo-a");
    const projectId = getProjectIdFor(projectRoot);
    const devHome = join(tmpHome, ".aimux-dev");

    vi.mocked(requestJson).mockRejectedValueOnce(new Error("other daemon unavailable"));
    execFileSyncMock.mockReturnValue("sleep 999");
    mkdirSync(join(devHome, "daemon"), { recursive: true });
    writeJson(join(devHome, "daemon", "daemon.json"), { pid: 1001, port: 43191 });
    writeJson(join(devHome, "daemon", "state.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        [projectId]: { pid: 2001, projectRoot },
      },
    });

    await takeOverProjectFromOtherOwners(projectRoot);

    expect(livePids.has(2001)).toBe(true);
    const state = JSON.parse(readFileSync(join(devHome, "daemon", "state.json"), "utf-8")) as {
      projects: Record<string, unknown>;
    };
    expect(state.projects[projectId]).toBeUndefined();
  });
});
