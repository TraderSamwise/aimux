import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAimuxProjectServiceProcess,
  isExitedProcessState,
  isPidAlive,
  listProcessArgs,
  readProcessArgs,
  readProcessCwd,
} from "./process-inspector.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const execFileSyncMock = vi.mocked(execFileSync);

describe("process-inspector", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it("reads process args", () => {
    execFileSyncMock.mockReturnValue("node dist/launcher-bin.js --flag\n");

    expect(readProcessArgs(123)).toBe("node dist/launcher-bin.js --flag");
    expect(execFileSyncMock).toHaveBeenCalledWith("ps", ["-o", "args=", "-p", "123"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("returns null when process args cannot be read", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("missing");
    });

    expect(readProcessArgs(123)).toBeNull();
  });

  it("lists process args from ps output", () => {
    execFileSyncMock.mockReturnValue("  12 node a\nbad\n  34 /bin/sh -c echo ok\n");

    expect(listProcessArgs()).toEqual([
      { pid: 12, args: "node a" },
      { pid: 34, args: "/bin/sh -c echo ok" },
    ]);
  });

  it("reads process cwd from lsof output", () => {
    execFileSyncMock.mockReturnValue("p123\nn/Users/sam/cs/aimux\n");

    expect(readProcessCwd(123)).toBe("/Users/sam/cs/aimux");
  });

  it("treats zombie states as exited", () => {
    expect(isExitedProcessState("Z+")).toBe(true);
    expect(isExitedProcessState("S+")).toBe(false);
  });

  it("treats missing pids as dead", () => {
    killSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });

    expect(isPidAlive(123)).toBe(false);
  });

  it("treats zombie pids as dead", () => {
    execFileSyncMock.mockReturnValue("Z+\n");

    expect(isPidAlive(123)).toBe(false);
  });

  it("verifies project service identity by exact project id and root args", () => {
    execFileSyncMock.mockReturnValue(
      "node dist/launcher-bin.js __project-service-internal --project-id aimux-1 --project-root /tmp/aimux\n",
    );

    expect(isAimuxProjectServiceProcess(123, { projectId: "aimux-1", projectRoot: "/tmp/aimux" })).toBe(true);
    expect(isAimuxProjectServiceProcess(123, { projectId: "aimux", projectRoot: "/tmp/aimux" })).toBe(false);
    expect(isAimuxProjectServiceProcess(123, { projectId: "aimux-1", projectRoot: "/tmp/aim" })).toBe(false);
  });

  it("falls back to cwd for legacy project services without identity args", () => {
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "ps") return "node /opt/aimux/dist/main.js __project-service-internal\n";
      if (command === "lsof") return "p123\nn/Users/sam/cs/aimux\n";
      throw new Error(command);
    });

    expect(isAimuxProjectServiceProcess(123, { projectRoot: "/Users/sam/cs/aimux" })).toBe(true);
    expect(isAimuxProjectServiceProcess(123, { projectRoot: "/Users/sam/cs/premys" })).toBe(false);
  });

  it("rejects non project-service processes", () => {
    execFileSyncMock.mockReturnValue("node dist/launcher-bin.js daemon\n");

    expect(isAimuxProjectServiceProcess(123, { projectId: "aimux-1" })).toBe(false);
  });
});
