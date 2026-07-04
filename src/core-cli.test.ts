import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_COMMAND_NAMES, type CoreCommandName } from "./core-command-contract.js";

const mocks = vi.hoisted(() => ({
  credentials: null as null | {
    version: 1;
    relayUrl: string;
    token: string;
    userId: string;
    createdAt: string;
    remoteEnabled: boolean;
  },
  daemonInfo: null as null | { pid: number; port: number; startedAt: string; updatedAt: string },
  daemonState: {
    version: 1 as const,
    updatedAt: new Date(0).toISOString(),
    projects: {} as Record<
      string,
      { projectId: string; projectRoot: string; pid: number; startedAt: string; updatedAt: string }
    >,
  },
  findMainRepo: vi.fn(),
  initPaths: vi.fn(),
  requestCoreCommand: vi.fn(),
  setRemoteEnabled: vi.fn(),
}));

vi.mock("./core-command-client.js", () => ({
  requestCoreCommand: mocks.requestCoreCommand,
}));

vi.mock("./credentials.js", () => ({
  loadCredentials: () => mocks.credentials,
  setRemoteEnabled: mocks.setRemoteEnabled,
}));

vi.mock("./daemon-state.js", () => ({
  loadDaemonInfo: () => mocks.daemonInfo,
  loadDaemonState: () => mocks.daemonState,
}));

vi.mock("./paths.js", () => ({
  initPaths: mocks.initPaths,
}));

vi.mock("./worktree.js", () => ({
  findMainRepo: mocks.findMainRepo,
}));

import { runCoreCli } from "./core-cli.js";

const iso = new Date(0).toISOString();

function statusResult() {
  return {
    daemon: {
      pid: 42,
      port: 43190,
      startedAt: iso,
      updatedAt: iso,
      serviceInfo: { api: 4, build: "build-a" },
    },
    projects: [
      {
        id: "repo-1",
        name: "repo",
        path: "/repo",
        dashboardSessionName: "aimux-repo",
        service: { pid: 77 },
        serviceAlive: true,
        serviceEndpoint: { host: "127.0.0.1", port: 45000 },
      },
    ],
    relay: {
      status: "connected",
      relayUrl: "wss://relay.example",
      lastConnectedAt: iso,
      lastError: null,
    },
    updatedAt: iso,
  };
}

function commandOk(command: CoreCommandName, result: unknown) {
  return {
    ok: true,
    id: "test",
    command,
    issuedAt: iso,
    result,
  };
}

async function run(args: string[], cwd = "/repo") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCoreCli(args, {
    cwd: () => cwd,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe("runCoreCli", () => {
  beforeEach(() => {
    mocks.credentials = null;
    mocks.daemonInfo = { pid: 123, port: 43190, startedAt: iso, updatedAt: iso };
    mocks.daemonState = { version: 1, updatedAt: iso, projects: {} };
    mocks.findMainRepo.mockReset();
    mocks.findMainRepo.mockImplementation((cwd: string) => cwd);
    mocks.initPaths.mockReset();
    mocks.requestCoreCommand.mockReset();
    mocks.requestCoreCommand.mockImplementation(async (command: CoreCommandName, payload: unknown) => {
      if (command === CORE_COMMAND_NAMES.status) return commandOk(command, statusResult());
      if (command === CORE_COMMAND_NAMES.projectsList) return commandOk(command, { projects: statusResult().projects });
      if (command === CORE_COMMAND_NAMES.projectEnsure) {
        return commandOk(command, {
          project: {
            projectId: "repo-1",
            projectRoot: (payload as { projectRoot: string }).projectRoot,
            pid: 88,
            startedAt: iso,
            updatedAt: iso,
          },
        });
      }
      if (command === CORE_COMMAND_NAMES.relayStatus || command === CORE_COMMAND_NAMES.relayEnable) {
        return commandOk(command, {
          relay: {
            status: "connected",
            relayUrl: "wss://relay.example",
            lastConnectedAt: iso,
            lastError: null,
          },
        });
      }
      if (command === CORE_COMMAND_NAMES.relayDisable) return commandOk(command, { relay: { status: "off" } });
      throw new Error(`unexpected command ${command}`);
    });
    mocks.setRemoteEnabled.mockReset();
  });

  it("renders host status from the core sidecar", async () => {
    const result = await run(["host", "status"]);

    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(mocks.initPaths).toHaveBeenCalledWith("/repo");
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.status);
    expect(result.stdout).toEqual([
      "Service: live",
      "Service pid=77",
      'Metadata: {"host":"127.0.0.1","port":45000}',
      'Expected manifest: {"api":4,"build":"build-a"}',
      "Tmux session: aimux-repo",
    ]);
  });

  it("emits host status JSON with the existing payload shape", async () => {
    const result = await run(["host", "status", "--json"]);
    const payload = JSON.parse(result.stdout.join("\n")) as { projectRoot: string; serviceAlive: boolean };

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({ projectRoot: "/repo", serviceAlive: true });
  });

  it("uses stored state for daemon status when the daemon is not reachable", async () => {
    mocks.daemonInfo = null;
    mocks.daemonState.projects.repo = {
      projectId: "repo",
      projectRoot: "/repo",
      pid: 77,
      startedAt: iso,
      updatedAt: iso,
    };
    mocks.requestCoreCommand.mockRejectedValueOnce(new Error("offline"));

    const result = await run(["daemon", "status"]);

    expect(result).toMatchObject({ code: 0, stdout: ["aimux daemon is not running."] });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.status, undefined, {
      ensureDaemon: false,
      timeoutMs: 1000,
    });
  });

  it("ensures a project through the sidecar command transport", async () => {
    const result = await run(["daemon", "project-ensure", "--project", "/repo"]);

    expect(result).toMatchObject({ code: 0, stdout: ["Ensured project service for /repo (pid 88)"] });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectEnsure, { projectRoot: "/repo" });
  });

  it("supports Commander-compatible project option forms", async () => {
    await expect(run(["daemon", "project-ensure", "--project=/repo"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Ensured project service for /repo (pid 88)"],
    });
    mocks.requestCoreCommand.mockClear();

    await expect(
      run(["daemon", "project-ensure", "--project", "/wrong", "--project", "/repo", "--json"]),
    ).resolves.toMatchObject({ code: 0 });

    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectEnsure, { projectRoot: "/repo" });
  });

  it("rejects direct malformed project ensure invocations without mutating", async () => {
    const result = await run(["daemon", "project-ensure", "--project", "--json"]);

    expect(result).toMatchObject({ code: 1, stdout: [] });
    expect(result.stderr[0]).toContain("invalid daemon project-ensure arguments");
    expect(mocks.requestCoreCommand).not.toHaveBeenCalled();
  });

  it("rejects unknown project ensure options without mutating", async () => {
    const result = await run(["daemon", "project-ensure", "--project", "/repo", "--dry-run"]);

    expect(result).toMatchObject({ code: 1, stdout: [] });
    expect(mocks.requestCoreCommand).not.toHaveBeenCalled();
  });

  it("rejects direct unknown options on mutating remote commands without mutating", async () => {
    const result = await run(["remote", "enable", "--json"]);

    expect(result).toMatchObject({ code: 2, stdout: [] });
    expect(mocks.requestCoreCommand).not.toHaveBeenCalled();
  });

  it("rejects direct extra positionals without mutating", async () => {
    await expect(run(["remote", "enable", "extra"])).resolves.toMatchObject({ code: 2, stdout: [] });
    await expect(run(["daemon", "status", "extra"])).resolves.toMatchObject({ code: 2, stdout: [] });

    expect(mocks.requestCoreCommand).not.toHaveBeenCalled();
  });

  it("lists projects with daemon and user-facing badges", async () => {
    await expect(run(["daemon", "projects"])).resolves.toMatchObject({
      stdout: ["repo  service  /repo"],
    });
    await expect(run(["projects", "list"])).resolves.toMatchObject({
      stdout: ["repo  live  /repo"],
    });
  });

  it("uses relay sidecar commands for remote operations", async () => {
    mocks.credentials = {
      version: 1,
      relayUrl: "wss://relay.example",
      token: "token",
      userId: "user-1",
      createdAt: iso,
      remoteEnabled: true,
    };

    await expect(run(["remote", "status"])).resolves.toMatchObject({
      stdout: ["Remote access: enabled", "Relay: wss://relay.example", "Connection: connected"],
    });
    await expect(run(["remote", "enable"])).resolves.toMatchObject({
      stdout: ["✓ Remote access enabled (connection: connected)"],
    });
    await expect(run(["remote", "disable"])).resolves.toMatchObject({
      stdout: ["✓ Remote access disabled. Daemon disconnected from relay."],
    });
  });

  it("keeps credential-only remote disable local when the daemon is down", async () => {
    mocks.daemonInfo = null;

    const result = await run(["remote", "disable"]);

    expect(result).toMatchObject({ code: 0, stdout: ["✓ Remote access disabled."] });
    expect(mocks.setRemoteEnabled).toHaveBeenCalledWith(false);
  });
});
