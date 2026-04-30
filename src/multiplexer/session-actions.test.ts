import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { forkAgent, spawnAgent } from "./session-actions.js";

vi.mock("../config.js", () => ({
  loadConfig: () => ({
    tools: {
      codex: { command: "codex", enabled: true, args: [], preambleFlag: undefined, sessionIdFlag: undefined },
      claude: { command: "claude", enabled: true, args: [], preambleFlag: undefined, sessionIdFlag: undefined },
    },
  }),
}));

vi.mock("./tool-picker.js", () => ({
  isToolAvailable: () => true,
}));

describe("session actions", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-actions-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("waits for live entry readiness before falling back on spawn", async () => {
    const target = { sessionName: "aimux-test", windowId: "@2", windowName: "codex" };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      createSession: vi.fn(() => ({ id: "codex-1" })),
      sessionTmuxTargets: new Map([["codex-1", target]]),
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "opened"),
      openLiveTmuxWindowForEntry: vi.fn(),
      tmuxRuntimeManager: {
        openTarget: vi.fn(),
        isInsideTmux: vi.fn(() => true),
      },
    };

    await spawnAgent(host, { toolConfigKey: "codex" });

    expect(host.waitAndOpenLiveTmuxWindowForEntry).toHaveBeenCalledWith({ id: "codex-1" });
    expect(host.tmuxRuntimeManager.openTarget).not.toHaveBeenCalled();
  });

  it("falls back to direct target open after readiness wait misses on fork", async () => {
    const target = { sessionName: "aimux-test", windowId: "@3", windowName: "claude" };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      forkSessionFromSource: vi.fn(async () => ({
        sessionId: "claude-2",
        threadId: "thread-1",
        target,
      })),
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "missing"),
      openLiveTmuxWindowForEntry: vi.fn(),
      tmuxRuntimeManager: {
        openTarget: vi.fn(),
        isInsideTmux: vi.fn(() => false),
      },
    };

    const result = await forkAgent(host, {
      sourceSessionId: "claude-1",
      targetToolConfigKey: "claude",
    });

    expect(result).toEqual({ sessionId: "claude-2", threadId: "thread-1" });
    expect(host.waitAndOpenLiveTmuxWindowForEntry).toHaveBeenCalledWith({ id: "claude-2" });
    expect(host.tmuxRuntimeManager.openTarget).toHaveBeenCalledWith(target, { insideTmux: false });
  });
});
