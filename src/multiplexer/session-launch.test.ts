import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "../paths.js";
import { createSession, runProjectService } from "./session-launch.js";

describe("createSession", () => {
  it("does not inject startup preamble when explicitly suppressed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const buildSessionPreamble = vi.fn(() => "aimux preamble");
    const deliverDetachedCodexKickoffPrompt = vi.fn();
    const sessions: any[] = [];
    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble,
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(() => "kickoff"),
        deliverDetachedCodexKickoffPrompt,
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn((session: any) => sessions.push(session)),
      sessions,
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    const session = createSession(
      host,
      "codex",
      [],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "backend-session",
      "codex-1",
      false,
      true,
    );

    expect(buildSessionPreamble).not.toHaveBeenCalled();
    expect(host.sessionBootstrap.buildInitialKickoffPrompt).not.toHaveBeenCalled();
    expect(deliverDetachedCodexKickoffPrompt).not.toHaveBeenCalled();

    session.destroy();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("wraps claude launches through the managed env boundary", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-claude-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    createSession(host, "claude", [], undefined, "claude", undefined, undefined, repoRoot);

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    expect(createWindowArgs[3]).toBe("env");
    expect(createWindowArgs[4][0]).toBe("-i");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_SESSION_ID=claude-");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_TOOL=claude");
    expect(createWindowArgs[4]).toContain("claude");

    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("runProjectService", () => {
  it("starts the dispatcher refresh loop", async () => {
    const resolveRun = vi.fn();
    const host: any = {
      mode: "dashboard",
      syncSessionsFromState: vi.fn(),
      createTaskDispatcher: vi.fn(() => ({ tick: vi.fn(), drainEvents: vi.fn(() => []) })),
      createOrchestrationDispatcher: vi.fn(() => ({ tick: vi.fn(), drainEvents: vi.fn(() => []) })),
      writeInstructionFiles: vi.fn(),
      startProjectServices: vi.fn(),
      startStatusRefresh: vi.fn(() => resolveRun(0)),
      refreshDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
    };

    const runPromise = runProjectService(host);
    await vi.waitFor(() => expect(host.resolveRun).toBeTypeOf("function"));
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.mode).toBe("project-service");
    expect(host.startStatusRefresh).toHaveBeenCalledOnce();
  });
});
