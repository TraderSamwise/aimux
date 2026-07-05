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
  clearLogFile: vi.fn(),
  parseLineCount: vi.fn(),
  readLastLogLines: vi.fn(),
  selectedLogPath: vi.fn(),
  requestCoreCommand: vi.fn(),
  tmuxIsInsideTmux: vi.fn(),
  tmuxOpenTarget: vi.fn(),
  setRemoteEnabled: vi.fn(),
  clearCredentials: vi.fn(),
  runLoginFlow: vi.fn(),
}));

vi.mock("./core-command-client.js", () => ({
  requestCoreCommand: mocks.requestCoreCommand,
}));

vi.mock("./credentials.js", () => ({
  clearCredentials: mocks.clearCredentials,
  loadCredentials: () => mocks.credentials,
  setRemoteEnabled: mocks.setRemoteEnabled,
}));

vi.mock("./daemon-state.js", () => ({
  loadDaemonInfo: () => mocks.daemonInfo,
  loadDaemonState: () => mocks.daemonState,
}));

vi.mock("./login-flow.js", () => ({
  runLoginFlow: mocks.runLoginFlow,
}));

vi.mock("./logs.js", () => ({
  clearLogFile: mocks.clearLogFile,
  parseLineCount: mocks.parseLineCount,
  readLastLogLines: mocks.readLastLogLines,
  selectedLogPath: mocks.selectedLogPath,
}));

vi.mock("./paths.js", () => ({
  initPaths: mocks.initPaths,
}));

vi.mock("./tmux/runtime-manager.js", () => ({
  TmuxRuntimeManager: class {
    isInsideTmux() {
      return mocks.tmuxIsInsideTmux();
    }

    openTarget(...args: unknown[]) {
      return mocks.tmuxOpenTarget(...args);
    }
  },
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

function runtimeRestartResult(failures = 0) {
  return {
    daemon: { status: "restarted", previous: null, current: { pid: 123, port: 43190 } },
    summary: { projects: 0, servicesEnsured: 0, dashboardsReloaded: 0, failures },
    projects: [],
    verification: { ok: failures === 0, error: failures > 0 ? "verification failed" : null },
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
    mocks.clearLogFile.mockReset();
    mocks.parseLineCount.mockReset();
    mocks.parseLineCount.mockImplementation((value: string | undefined) => {
      const parsed = Number.parseInt(value ?? "80", 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
    });
    mocks.readLastLogLines.mockReset();
    mocks.readLastLogLines.mockReturnValue("line one\nline two");
    mocks.selectedLogPath.mockReset();
    mocks.selectedLogPath.mockImplementation((opts: { daemon?: boolean; project?: string }) => {
      if (opts.daemon) return "/logs/daemon.jsonl";
      if (opts.project) return `/logs/project:${opts.project}`;
      return "/logs/current-project.jsonl";
    });
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
      if (command === CORE_COMMAND_NAMES.projectStop || command === CORE_COMMAND_NAMES.projectKill) {
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
      if (command === CORE_COMMAND_NAMES.projectRestart) {
        return commandOk(command, {
          project: {
            projectId: "repo-1",
            projectRoot: (payload as { projectRoot: string }).projectRoot,
            pid: 89,
            startedAt: iso,
            updatedAt: iso,
          },
          dashboardSessionName: (payload as { serve?: boolean }).serve ? undefined : "aimux-repo",
          dashboardTarget: (payload as { serve?: boolean }).serve
            ? undefined
            : { sessionName: "aimux-repo", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
        });
      }
      if (command === CORE_COMMAND_NAMES.restart) {
        return commandOk(command, {
          restart: runtimeRestartResult(),
          text: "Aimux Restart\nfailures: 0",
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
    mocks.clearCredentials.mockReset();
    mocks.clearCredentials.mockReturnValue("cleared");
    mocks.runLoginFlow.mockReset();
    mocks.runLoginFlow.mockResolvedValue({ userId: "user-1" });
    mocks.tmuxIsInsideTmux.mockReset();
    mocks.tmuxIsInsideTmux.mockReturnValue(true);
    mocks.tmuxOpenTarget.mockReset();
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

  it("serves the current project through the sidecar command transport", async () => {
    const result = await run(["serve"]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["aimux serve: daemon managing /repo (service pid 88)"],
    });
    expect(mocks.initPaths).toHaveBeenCalledWith("/repo");
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectEnsure, { projectRoot: "/repo" });
  });

  it("runs host service mutations through the sidecar command transport", async () => {
    await expect(run(["host", "stop"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Stopped project service pid 88"],
    });
    await expect(run(["host", "kill"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Killed project service pid 88"],
    });
    await expect(run(["host", "restart"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Restarted project service for aimux-repo"],
    });
    await expect(run(["host", "restart", "--serve"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Restarted project service for /repo"],
    });
    await expect(run(["host", "restart", "--open"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Restarted project service for aimux-repo"],
    });
    await expect(run(["host", "restart", "--serve", "--open"])).resolves.toMatchObject({
      code: 1,
      stdout: ["Restarted project service for /repo"],
      stderr: ["error: restarted project service, but no dashboard target was available to open"],
    });

    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectStop, { projectRoot: "/repo" });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectKill, { projectRoot: "/repo" });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectRestart, {
      projectRoot: "/repo",
      serve: false,
    });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectRestart, {
      projectRoot: "/repo",
      serve: true,
    });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectRestart, {
      projectRoot: "/repo",
      serve: false,
    });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.projectRestart, {
      projectRoot: "/repo",
      serve: true,
    });
    expect(mocks.tmuxOpenTarget).toHaveBeenCalledTimes(1);
    expect(mocks.tmuxOpenTarget).toHaveBeenCalledWith(
      { sessionName: "aimux-repo", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
      { insideTmux: true, alreadyResolved: true },
    );
  });

  it("runs global and daemon restart through the sidecar command transport", async () => {
    await expect(run(["restart", "--project", "/repo", "--json"])).resolves.toMatchObject({
      code: 0,
    });
    expect(JSON.parse((await run(["daemon", "restart", "--json"])).stdout.join("\n"))).toMatchObject({
      summary: { failures: 0 },
    });
    await expect(run(["restart"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Aimux Restart\nfailures: 0"],
    });

    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.restart, { projectRoot: "/repo" });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.restart, undefined);
  });

  it("returns restart failures as a non-zero core CLI exit", async () => {
    mocks.requestCoreCommand.mockImplementationOnce(async (command: CoreCommandName) =>
      commandOk(command, {
        restart: runtimeRestartResult(1),
        text: "Aimux Restart\nfailures: 1",
      }),
    );

    const result = await run(["restart"]);

    expect(result).toMatchObject({ code: 1, stdout: ["Aimux Restart\nfailures: 1"] });
  });

  it("runs logs diagnostics through the core fallback", async () => {
    await expect(run(["logs", "path", "--daemon"])).resolves.toMatchObject({
      code: 0,
      stdout: ["/logs/daemon.jsonl"],
    });

    await expect(run(["logs", "tail", "--project", "-foo", "-n", "-5"])).resolves.toMatchObject({
      code: 0,
      stdout: ["line one\nline two"],
    });

    await expect(run(["logs", "clear", "--project=/repo"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Cleared /logs/project:/repo"],
    });

    expect(mocks.parseLineCount).toHaveBeenCalledWith("-5");
    expect(mocks.readLastLogLines).toHaveBeenCalledWith("/logs/project:-foo", 80);
    expect(mocks.clearLogFile).toHaveBeenCalledWith("/logs/project:/repo");
    expect(mocks.initPaths).not.toHaveBeenCalled();
  });

  it("initializes project paths for current-project logs fallback", async () => {
    const result = await run(["logs", "path"], "/repo/subdir");

    expect(result).toMatchObject({ code: 0, stdout: ["/logs/current-project.jsonl"] });
    expect(mocks.initPaths).toHaveBeenCalledWith("/repo/subdir");
  });

  it("returns empty log tails as core fallback errors", async () => {
    mocks.readLastLogLines.mockReturnValueOnce("");

    const result = await run(["logs", "tail", "--daemon"]);

    expect(result).toMatchObject({ code: 1, stdout: [], stderr: ["No log entries at /logs/daemon.jsonl"] });
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

  it("renders whoami without leaking credential tokens", async () => {
    mocks.credentials = {
      version: 1,
      relayUrl: "wss://relay.example",
      token: "secret-token",
      userId: "user-1",
      createdAt: iso,
      remoteEnabled: true,
    };

    await expect(run(["whoami"])).resolves.toMatchObject({
      code: 0,
      stdout: ["Logged in as user-1", "Relay: wss://relay.example", "Remote access: enabled"],
    });
    const jsonResult = await run(["whoami", "--json"]);
    const payload = JSON.parse(jsonResult.stdout.join("\n")) as Record<string, unknown>;

    expect(jsonResult.code).toBe(0);
    expect(payload).toEqual({
      loggedIn: true,
      userId: "user-1",
      relayUrl: "wss://relay.example",
      remoteEnabled: true,
    });
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });

  it("logs out through the core fallback and disconnects a running daemon best-effort", async () => {
    const result = await run(["logout"]);

    expect(result).toMatchObject({ code: 0, stdout: ["✓ Logged out. Remote access disabled."], stderr: [] });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.relayDisable, undefined, {
      ensureDaemon: false,
      timeoutMs: 1000,
    });
    expect(mocks.clearCredentials).toHaveBeenCalled();
  });

  it("returns logout credential removal failures on stderr", async () => {
    mocks.clearCredentials.mockReturnValue("failed");

    const result = await run(["logout"]);

    expect(result).toMatchObject({
      code: 1,
      stdout: [],
      stderr: ["Failed to remove credentials file — check permissions."],
    });
  });

  it("runs login through the core fallback and reconnects a running daemon", async () => {
    const result = await run(["login"]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["", "✓ Logged in as user-1", "Remote access is enabled (connection: connected)."],
    });
    expect(mocks.runLoginFlow).toHaveBeenCalledWith();
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.relayEnable, undefined, {
      ensureDaemon: false,
      timeoutMs: 1000,
    });
  });

  it("runs login through the core fallback when no daemon is running", async () => {
    mocks.daemonInfo = null;

    const result = await run(["login"]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["", "✓ Logged in as user-1", "Remote access is enabled. The daemon will connect on next start."],
    });
    expect(mocks.requestCoreCommand).not.toHaveBeenCalledWith(CORE_COMMAND_NAMES.relayEnable, undefined, {
      ensureDaemon: false,
      timeoutMs: 1000,
    });
  });

  it("renders relay refresh failure without calling the login failed", async () => {
    mocks.requestCoreCommand.mockImplementation(async (command: CoreCommandName) => {
      if (command === CORE_COMMAND_NAMES.relayEnable) throw new Error("relay refused");
      throw new Error(`unexpected command ${command}`);
    });

    const result = await run(["login"]);

    expect(result).toMatchObject({
      code: 0,
      stdout: [
        "",
        "✓ Logged in as user-1",
        "Remote access credentials were saved, but relay is disconnected.",
        "Last error: relay refused",
      ],
    });
  });

  it("runs security unlock through the core fallback", async () => {
    const result = await run(["security", "unlock"]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["", "✓ Security unlocked for user-1", "Remote access is enabled (connection: connected)."],
    });
    expect(mocks.runLoginFlow).toHaveBeenCalledWith({ action: "security-unlock" });
    expect(mocks.requestCoreCommand).toHaveBeenCalledWith(CORE_COMMAND_NAMES.relayEnable, undefined, {
      ensureDaemon: false,
      timeoutMs: 1000,
    });
  });
});
