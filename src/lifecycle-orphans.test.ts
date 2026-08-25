import { describe, expect, it, vi } from "vitest";
import {
  cleanupLifecycleValidationOrphans,
  isLifecycleValidationProcessArgs,
  isLifecycleValidationTmuxSession,
} from "./lifecycle-orphans.js";

describe("lifecycle validation orphan cleanup", () => {
  const retiredMainEntrypoint = ["/Users/sam/.aimux/native/current/dist", "main.js"].join("/");

  it("matches only validation-owned process command lines", () => {
    expect(
      isLifecycleValidationProcessArgs(
        "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon",
      ),
    ).toBe(true);
    expect(isLifecycleValidationProcessArgs(`env AIMUX_HOME=/tmp/aimux-home-validate42 ${retiredMainEntrypoint}`)).toBe(
      true,
    );

    expect(
      isLifecycleValidationProcessArgs(
        "/bin/zsh -c tmux set-option @aimux-project-root /tmp/aimux-home-validate42/project",
      ),
    ).toBe(false);
    expect(
      isLifecycleValidationProcessArgs(
        "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/current/dist/launcher-bin.js daemon run daemon",
      ),
    ).toBe(false);
    expect(
      isLifecycleValidationProcessArgs(
        "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-user-lifecycle-validate-feature/dist/launcher-bin.js daemon run daemon",
      ),
    ).toBe(false);
    expect(
      isLifecycleValidationProcessArgs(
        '/bin/zsh -lc entry=/Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js node "$entry" daemon run daemon',
      ),
    ).toBe(false);
    expect(isLifecycleValidationProcessArgs("codex --model gpt-5.5")).toBe(false);
  });

  it("matches validation tmux sessions by name or scoped Aimux options", () => {
    const tmux = {
      isAvailable: () => true,
      getSessionOption: (sessionName: string, option: string) => {
        if (sessionName === "aimux-temp-123" && option === "@aimux-project-root") {
          return "/tmp/aimux-home-validate99/project";
        }
        if (sessionName === "aimux-state-123" && option === "@aimux-project-state-dir") {
          return "/tmp/aimux-lifecycle-visible/project-state";
        }
        return null;
      },
    };

    expect(isLifecycleValidationTmuxSession("aimux-aimux-lifecycle-validate21", tmux)).toBe(true);
    expect(isLifecycleValidationTmuxSession("aimux-temp-123", tmux)).toBe(true);
    expect(isLifecycleValidationTmuxSession("aimux-state-123", tmux)).toBe(true);
    expect(isLifecycleValidationTmuxSession("aimux-tealstreet-next-123", tmux)).toBe(false);
    expect(isLifecycleValidationTmuxSession("aimux-tealstreet-lifecycle-validate-feature", tmux)).toBe(false);
  });

  it("does not match normal tmux sessions whose project path contains lifecycle words", () => {
    const tmux = {
      isAvailable: () => true,
      getSessionOption: (sessionName: string, option: string) => {
        if (sessionName === "aimux-normal-123" && option === "@aimux-project-root") {
          return "/Users/sam/cs/lifecycle-validate-feature";
        }
        return null;
      },
    };

    expect(isLifecycleValidationTmuxSession("aimux-normal-123", tmux)).toBe(false);
  });

  it("kills validation processes and sessions without touching regular Aimux runtime", async () => {
    const killedProcesses: Array<[number, NodeJS.Signals]> = [];
    const alive = new Set([101, 202]);
    const killedSessions: string[] = [];
    const tmux = {
      isAvailable: () => true,
      listSessionNames: () => ["aimux-tealstreet-next-abc", "aimux-aimux-lifecycle-validate25", "aimux-option-only"],
      getSessionOption: (sessionName: string, option: string) => {
        if (sessionName === "aimux-option-only" && option === "@aimux-project-state-dir") {
          return "/tmp/aimux-home-validate25/state";
        }
        return null;
      },
      killSession: (sessionName: string) => {
        killedSessions.push(sessionName);
      },
    };

    const result = await cleanupLifecycleValidationOrphans({
      tmux,
      currentPid: 999,
      listProcesses: () => [
        {
          pid: 101,
          args: "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon",
        },
        {
          pid: 202,
          args: `env AIMUX_HOME=/tmp/aimux-home-validate25 ${retiredMainEntrypoint}`,
        },
        {
          pid: 303,
          args: "/Users/sam/.aimux/native/current/dist/launcher-bin.js daemon run daemon",
        },
        {
          pid: 999,
          args: "env AIMUX_HOME=/tmp/aimux-home-validate25 current test process",
        },
      ],
      readProcessArgs: (pid) =>
        ({
          101: "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon",
          202: `env AIMUX_HOME=/tmp/aimux-home-validate25 ${retiredMainEntrypoint}`,
        })[pid] ?? null,
      isPidAlive: (pid) => alive.has(pid),
      killPid: (pid, signal) => {
        killedProcesses.push([pid, signal]);
        alive.delete(pid);
      },
      sleep: vi.fn(async () => undefined),
      processExitTimeoutMs: 1,
      processKillGraceMs: 1,
    });

    expect(result).toEqual({
      attemptedProcessPids: [101, 202],
      processPids: [101, 202],
      failedProcessPids: [],
      attemptedTmuxSessions: ["aimux-aimux-lifecycle-validate25", "aimux-option-only"],
      tmuxSessions: ["aimux-aimux-lifecycle-validate25", "aimux-option-only"],
      failedTmuxSessions: [],
      errors: [],
    });
    expect(killedProcesses).toEqual([
      [101, "SIGTERM"],
      [202, "SIGTERM"],
    ]);
    expect(killedSessions).toEqual(["aimux-aimux-lifecycle-validate25", "aimux-option-only"]);
  });

  it("does not escalate to SIGKILL when a candidate pid no longer matches", async () => {
    const killedProcesses: Array<[number, NodeJS.Signals]> = [];
    const alive = new Set([101]);
    let reads = 0;

    const result = await cleanupLifecycleValidationOrphans({
      tmux: { isAvailable: () => false },
      listProcesses: () => [
        {
          pid: 101,
          args: "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon",
        },
      ],
      readProcessArgs: () => {
        reads += 1;
        if (reads === 1) {
          return "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon";
        }
        return "node /Users/sam/cs/app/server.js";
      },
      isPidAlive: (pid) => alive.has(pid),
      killPid: (pid, signal) => {
        killedProcesses.push([pid, signal]);
      },
      sleep: vi.fn(async () => undefined),
      processExitTimeoutMs: 1,
      processKillGraceMs: 1,
      currentPid: 999,
    });

    expect(killedProcesses).toEqual([[101, "SIGTERM"]]);
    expect(result.failedProcessPids).toEqual([101]);
    expect(result.errors).toEqual(["pid 101: command changed before SIGKILL"]);
  });

  it("reaps a dashboard whose window is gone", async () => {
    // A live dashboard's shell is a child of tmux. When the window or the server
    // goes away the shell is reparented to init and the node process keeps
    // running with nothing to render to. 59 of these accumulated in one day.
    const dash = (build: string) =>
      `/Users/sam/.volta/bin/node /Users/sam/.aimux/native/${build}/dist/launcher-bin.js --tmux-dashboard-internal`;
    const processes = [
      { pid: 11, args: dash("local-old") },
      { pid: 12, args: dash("local-current") },
      { pid: 13, args: dash("local-current") },
    ];
    // 11 and 12 hang off shells reparented to init; 13's shell descends from tmux.
    const parents = new Map<number, number>([
      [11, 111],
      [111, 1],
      [12, 112],
      [112, 1],
      [13, 113],
      [113, 900],
      [900, 1],
    ]);
    const killed: number[] = [];

    const result = await cleanupLifecycleValidationOrphans({
      currentPid: 999,
      tmux: { isAvailable: () => false } as never,
      listProcesses: () => processes,
      listProcessParents: () => parents,
      readProcessArgs: (pid) => processes.find((entry) => entry.pid === pid)?.args ?? null,
      isPidAlive: () => false,
      killPid: (pid) => {
        killed.push(pid);
      },
    });

    expect(killed.sort()).toEqual([11, 12]);
    expect(result.processPids.sort()).toEqual([11, 12]);
  });

  it("reaps a dashboard whose shell is not a live tmux pane anymore", async () => {
    const dash = "/Users/sam/.aimux/native/local-a/dist/launcher-bin.js --tmux-dashboard-internal";
    const processes = [
      { pid: 11, args: dash },
      { pid: 12, args: dash },
    ];
    const parents = new Map<number, number>([
      [11, 111],
      [111, 900],
      [12, 112],
      [112, 900],
      [900, 1],
    ]);
    const killed: number[] = [];

    const result = await cleanupLifecycleValidationOrphans({
      currentPid: 999,
      tmux: { isAvailable: () => true } as never,
      listProcesses: () => processes,
      listProcessParents: () => parents,
      listLiveTmuxPanePids: () => new Set([112]),
      readProcessArgs: (pid) => processes.find((entry) => entry.pid === pid)?.args ?? null,
      isPidAlive: () => false,
      killPid: (pid) => {
        killed.push(pid);
      },
    });

    expect(killed).toEqual([11]);
    expect(result.processPids).toEqual([11]);
  });

  it("never reaps a dashboard merely because its build differs", async () => {
    // Build difference is symmetric while the guard against replacing a newer
    // install is not, so reaping on it lets an older process kill the newer
    // build's live dashboards — the same bug inverted.
    const dash = "/Users/sam/.aimux/native/local-newer/dist/launcher-bin.js --tmux-dashboard-internal";
    const killed: number[] = [];
    await cleanupLifecycleValidationOrphans({
      currentPid: 999,
      tmux: { isAvailable: () => false } as never,
      listProcesses: () => [{ pid: 21, args: dash }],
      listProcessParents: () =>
        new Map([
          [21, 121],
          [121, 900],
          [900, 1],
        ]),
      readProcessArgs: () => dash,
      isPidAlive: () => false,
      killPid: (pid) => {
        killed.push(pid);
      },
    });
    expect(killed).toEqual([]);
  });

  it("does not kill a pid that is no longer a dashboard when re-read", async () => {
    // Guards pid reuse: the candidate list is a snapshot, so every pid is re-read
    // immediately before the kill and anything that is no longer a dashboard is
    // left alone. The parent chain is snapshotted once, so a pid recycled into a
    // *live dashboard* inside that window is not covered — vanishingly unlikely,
    // and named rather than papered over.
    const dash = "/Users/sam/.aimux/native/local-a/dist/launcher-bin.js --tmux-dashboard-internal";
    const killed: number[] = [];
    await cleanupLifecycleValidationOrphans({
      currentPid: 999,
      tmux: { isAvailable: () => false } as never,
      listProcesses: () => [{ pid: 31, args: dash }],
      listProcessParents: () =>
        new Map([
          [31, 131],
          [131, 1],
        ]),
      readProcessArgs: () => "/usr/bin/some-other-process --unrelated",
      isPidAlive: () => false,
      killPid: (pid) => {
        killed.push(pid);
      },
    });
    expect(killed).toEqual([]);
  });
});
