import { describe, expect, it, vi } from "vitest";
import {
  buildScribeBriefing,
  findScribeCandidates,
  SCRIBE_WATCHER_MAX_CANDIDATES,
  SCRIBE_WATCHER_MAX_OUTPUT_CHARS,
  SCRIBE_WATCHER_OUTPUT_START_LINE,
  ScribeWatcher,
  type ScribeWatcherSession,
} from "./scribe-watcher.js";
import type { MetadataState } from "./metadata-store.js";

function metadata(sessions: MetadataState["sessions"]): MetadataState {
  return { version: 1, sessions };
}

function makeSession(id: string, override: Partial<ScribeWatcherSession> = {}): ScribeWatcherSession {
  return { id, status: "running", tool: "codex", ...override };
}

describe("findScribeCandidates", () => {
  it("finds bounded idle/done normal sessions and skips project control sessions", () => {
    const sessions = [
      makeSession("scribe"),
      makeSession("overseer"),
      makeSession("idle-agent"),
      makeSession("done-agent", { status: "idle" }),
      makeSession("busy-agent"),
      makeSession("needs-input"),
    ];
    const state = metadata({
      scribe: { scribe: true, updatedAt: "2026-08-30T00:00:00.000Z" },
      overseer: { overseer: true, updatedAt: "2026-08-30T00:00:00.000Z" },
      "idle-agent": {
        derived: { activity: "idle", attention: "normal" },
        context: { worktreePath: "/repo/.aimux/worktrees/feature" },
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      "done-agent": {
        derived: { activity: "done", attention: "normal" },
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      "busy-agent": {
        derived: { activity: "working", attention: "normal" },
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      "needs-input": {
        derived: { activity: "idle", attention: "needs_response" },
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
    } as any);

    expect(findScribeCandidates(sessions, state, "scribe")).toEqual([
      {
        id: "idle-agent",
        status: "running",
        activity: "idle",
        attention: "normal",
        tool: "codex",
        worktreePath: "/repo/.aimux/worktrees/feature",
      },
      {
        id: "done-agent",
        status: "idle",
        activity: "done",
        attention: "normal",
        tool: "codex",
        worktreePath: undefined,
      },
    ]);
  });

  it("honors max candidates", () => {
    const sessions = Array.from({ length: 5 }, (_, index) => makeSession(`agent-${index}`));
    const state = metadata(
      Object.fromEntries(
        sessions.map((session) => [
          session.id,
          { derived: { activity: "idle", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
        ]),
      ) as any,
    );

    expect(findScribeCandidates(sessions, state, undefined, 2).map((candidate) => candidate.id)).toEqual([
      "agent-0",
      "agent-1",
    ]);
  });
});

describe("buildScribeBriefing", () => {
  it("renders changed bounded tails with ids and worktrees", () => {
    const text = buildScribeBriefing([
      {
        id: "codex-1",
        tool: "codex",
        status: "running",
        activity: "idle",
        attention: "normal",
        worktreePath: "/repo/.aimux/worktrees/task",
        output: "Implemented parser tests.\n",
        outputChars: 26,
        fingerprint: "abc",
      },
    ]);

    expect(text).toContain("[aimux scribe check]");
    expect(text).toContain("id=codex-1");
    expect(text).toContain("worktree=/repo/.aimux/worktrees/task");
    expect(text).toContain("Implemented parser tests.");
  });
});

describe("ScribeWatcher", () => {
  it("does nothing without a live scribe", async () => {
    const readAgentOutput = vi.fn();
    const sendAgentInput = vi.fn();
    const watcher = new ScribeWatcher({
      loadSessions: () => [makeSession("agent-1")],
      loadMetadata: () =>
        metadata({
          "agent-1": { derived: { activity: "idle", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
        } as any),
      readAgentOutput,
      sendAgentInput,
    });

    await watcher.scan();

    expect(readAgentOutput).not.toHaveBeenCalled();
    expect(sendAgentInput).not.toHaveBeenCalled();
  });

  it("sends one bounded briefing for changed candidate output", async () => {
    const output = `${"x".repeat(SCRIBE_WATCHER_MAX_OUTPUT_CHARS + 20)}meaningful tail`;
    const readAgentOutput = vi.fn(async () => ({ output }));
    const sendAgentInput = vi.fn(async () => undefined);
    const watcher = new ScribeWatcher({
      loadSessions: () => [makeSession("scribe"), makeSession("agent-1", { worktreePath: "/repo/task" })],
      loadMetadata: () =>
        metadata({
          scribe: {
            scribe: true,
            derived: { activity: "idle", attention: "normal" },
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
          "agent-1": { derived: { activity: "done", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
        } as any),
      readAgentOutput,
      sendAgentInput,
      now: () => 10_000,
    });

    await watcher.scan();

    expect(readAgentOutput).toHaveBeenCalledWith("agent-1", SCRIBE_WATCHER_OUTPUT_START_LINE);
    expect(sendAgentInput).toHaveBeenCalledTimes(1);
    const [, text] = sendAgentInput.mock.calls[0];
    expect(text).toContain("id=agent-1");
    expect(text).toContain("meaningful tail");
    expect(text).not.toContain("x".repeat(SCRIBE_WATCHER_MAX_OUTPUT_CHARS + 1));
  });

  it("does not resend unchanged fingerprints after cooldown", async () => {
    let now = 10_000;
    const readAgentOutput = vi.fn(async () => "same output");
    const sendAgentInput = vi.fn(async () => undefined);
    const watcher = new ScribeWatcher({
      loadSessions: () => [makeSession("scribe"), makeSession("agent-1")],
      loadMetadata: () =>
        metadata({
          scribe: {
            scribe: true,
            derived: { activity: "idle", attention: "normal" },
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
          "agent-1": { derived: { activity: "idle", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
        } as any),
      readAgentOutput,
      sendAgentInput,
      now: () => now,
      cooldownMs: 1,
    });

    await watcher.scan();
    now += 2;
    await watcher.scan();

    expect(readAgentOutput).toHaveBeenCalledTimes(2);
    expect(sendAgentInput).toHaveBeenCalledTimes(1);
  });

  it("keeps scanning other candidates when one read fails", async () => {
    const readAgentOutput = vi
      .fn()
      .mockRejectedValueOnce(new Error("pane gone"))
      .mockResolvedValueOnce({ output: "agent two finished docs" });
    const sendAgentInput = vi.fn(async () => undefined);
    const watcher = new ScribeWatcher({
      loadSessions: () => [makeSession("scribe"), makeSession("agent-1"), makeSession("agent-2")],
      loadMetadata: () =>
        metadata({
          scribe: {
            scribe: true,
            derived: { activity: "idle", attention: "normal" },
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
          "agent-1": { derived: { activity: "idle", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
          "agent-2": { derived: { activity: "idle", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
        } as any),
      readAgentOutput,
      sendAgentInput,
    });

    await watcher.scan();

    expect(readAgentOutput).toHaveBeenCalledTimes(2);
    expect(sendAgentInput).toHaveBeenCalledTimes(1);
    expect(sendAgentInput.mock.calls[0][1]).toContain("agent two finished docs");
  });

  it("skips sends while the scribe is busy", async () => {
    const readAgentOutput = vi.fn();
    const sendAgentInput = vi.fn();
    const watcher = new ScribeWatcher({
      loadSessions: () => [makeSession("scribe"), makeSession("agent-1")],
      loadMetadata: () =>
        metadata({
          scribe: {
            scribe: true,
            derived: { activity: "working", attention: "normal" },
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
          "agent-1": { derived: { activity: "idle", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
        } as any),
      readAgentOutput,
      sendAgentInput,
    });

    await watcher.scan();

    expect(readAgentOutput).not.toHaveBeenCalled();
    expect(sendAgentInput).not.toHaveBeenCalled();
  });

  it("continues past unchanged early candidates before applying delivery cap", async () => {
    let now = 10_000;
    const sessions = [
      makeSession("scribe"),
      ...Array.from({ length: SCRIBE_WATCHER_MAX_CANDIDATES }, (_, index) => makeSession(`unchanged-${index}`)),
      makeSession("changed-later"),
    ];
    const readAgentOutput = vi.fn(async (sessionId: string) =>
      sessionId === "changed-later" ? "new later work" : "same noise",
    );
    const sendAgentInput = vi.fn(async () => undefined);
    const watcher = new ScribeWatcher({
      loadSessions: () => sessions,
      loadMetadata: () =>
        metadata({
          scribe: {
            scribe: true,
            derived: { activity: "idle", attention: "normal" },
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
          ...Object.fromEntries(
            sessions
              .filter((session) => session.id !== "scribe")
              .map((session) => [
                session.id,
                { derived: { activity: "idle", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
              ]),
          ),
        } as any),
      readAgentOutput,
      sendAgentInput,
      now: () => now,
      cooldownMs: 1,
      maxCandidates: SCRIBE_WATCHER_MAX_CANDIDATES,
    });

    await watcher.scan();
    now += 2;
    await watcher.scan();

    expect(sendAgentInput).toHaveBeenCalledTimes(2);
    expect(sendAgentInput.mock.calls[1][1]).toContain("changed-later");
  });

  it("does not deliver an in-flight scan after stop", async () => {
    let resolveRead: (value: string) => void = () => {};
    const readAgentOutput = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const sendAgentInput = vi.fn(async () => undefined);
    const watcher = new ScribeWatcher({
      loadSessions: () => [makeSession("scribe"), makeSession("agent-1")],
      loadMetadata: () =>
        metadata({
          scribe: {
            scribe: true,
            derived: { activity: "idle", attention: "normal" },
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
          "agent-1": { derived: { activity: "idle", attention: "normal" }, updatedAt: "2026-08-30T00:00:00.000Z" },
        } as any),
      readAgentOutput,
      sendAgentInput,
    });

    const scan = watcher.scan();
    watcher.stop();
    resolveRead("work after shutdown");
    await scan;

    expect(sendAgentInput).not.toHaveBeenCalled();
  });
});
