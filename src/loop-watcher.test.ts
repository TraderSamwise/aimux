import { describe, expect, it, vi } from "vitest";
import { findLoopCandidates, LoopWatcher, type LoopWatcherDeps, type LoopWatcherSession } from "./loop-watcher.js";
import type { MetadataState, SessionMetadata } from "./metadata-store.js";
import type { LoopConfig } from "./config.js";
import type { AgentActivityState, AgentAttentionState } from "./agent-events.js";

function meta(input: Partial<SessionMetadata> = {}): SessionMetadata {
  return { updatedAt: "2026-06-13T00:00:00.000Z", ...input };
}

function derived(activity?: AgentActivityState, attention: AgentAttentionState = "normal"): SessionMetadata {
  return meta({ loop: { active: true, goal: "ship it", since: "x" }, derived: { activity, attention } });
}

function state(sessions: Record<string, SessionMetadata>): MetadataState {
  return { version: 1, sessions };
}

const sessions: LoopWatcherSession[] = [{ id: "a", status: "running", tool: "claude", worktreePath: "/wt/a" }];
const noPending = () => false;

describe("findLoopCandidates", () => {
  it("flags an in-loop agent that stopped (idle) without waiting on a human", () => {
    const result = findLoopCandidates(sessions, state({ a: derived("idle") }), { hasPendingInteraction: noPending });
    expect(result).toEqual([{ id: "a", goal: "ship it", worktreePath: "/wt/a", tool: "claude" }]);
  });

  it("flags an in-loop agent in the done activity state", () => {
    const result = findLoopCandidates(sessions, state({ a: derived("done") }), { hasPendingInteraction: noPending });
    expect(result.map((c) => c.id)).toEqual(["a"]);
  });

  it("ignores agents that are still working, waiting, errored, or interrupted", () => {
    for (const activity of ["running", "waiting", "error", "interrupted"] as AgentActivityState[]) {
      const result = findLoopCandidates(sessions, state({ a: derived(activity) }), {
        hasPendingInteraction: noPending,
      });
      expect(result).toEqual([]);
    }
  });

  it("ignores agents whose attention is not normal", () => {
    for (const attention of ["needs_input", "blocked", "error", "needs_response"] as AgentAttentionState[]) {
      const result = findLoopCandidates(sessions, state({ a: derived("idle", attention) }), {
        hasPendingInteraction: noPending,
      });
      expect(result).toEqual([]);
    }
  });

  it("ignores agents not marked in a loop", () => {
    const result = findLoopCandidates(sessions, state({ a: meta({ derived: { activity: "idle" } }) }), {
      hasPendingInteraction: noPending,
    });
    expect(result).toEqual([]);
  });

  it("ignores the overseer even if it is idle and in a loop", () => {
    const result = findLoopCandidates(sessions, state({ a: derived("idle") }), {
      overseerId: "a",
      hasPendingInteraction: noPending,
    });
    expect(result).toEqual([]);
  });

  it("ignores an agent with a pending interaction (waiting on a human)", () => {
    const result = findLoopCandidates(sessions, state({ a: derived("idle") }), {
      hasPendingInteraction: (id) => id === "a",
    });
    expect(result).toEqual([]);
  });
});

const config: LoopConfig = { scanIntervalMs: 15000, nudgeCooldownMs: 60000, autoNudgeWithoutOverseer: false };

function watcherDeps(overrides: Partial<LoopWatcherDeps> = {}) {
  const sendAgentInput = vi.fn(async () => ({}));
  let clock = 1_000_000;
  return {
    sendAgentInput,
    advance: (ms: number) => {
      clock += ms;
    },
    deps: {
      config,
      loadSessions: () => sessions,
      loadMetadata: () => state({ a: derived("idle") }),
      hasPendingInteraction: noPending,
      sendAgentInput,
      now: () => clock,
      ...overrides,
    },
  };
}

describe("LoopWatcher.scan", () => {
  it("wakes the overseer with a briefing when one is running, respecting cooldown", async () => {
    const overseerSessions: LoopWatcherSession[] = [...sessions, { id: "boss", status: "running" }];
    const { deps, sendAgentInput, advance } = watcherDeps({
      loadSessions: () => overseerSessions,
      loadMetadata: () => state({ a: derived("idle"), boss: meta({ overseer: true }) }),
    });
    const watcher = new LoopWatcher(deps);

    await watcher.scan();
    expect(sendAgentInput).toHaveBeenCalledTimes(1);
    expect(sendAgentInput.mock.calls[0][0]).toBe("boss");
    expect(sendAgentInput.mock.calls[0][1]).toContain("[aimux loop check]");
    expect(sendAgentInput.mock.calls[0][1]).toContain("- a");

    await watcher.scan(); // within cooldown
    expect(sendAgentInput).toHaveBeenCalledTimes(1);

    advance(config.nudgeCooldownMs + 1);
    await watcher.scan();
    expect(sendAgentInput).toHaveBeenCalledTimes(2);
  });

  it("does nothing without an overseer when autoNudge is off", async () => {
    const { deps, sendAgentInput } = watcherDeps();
    await new LoopWatcher(deps).scan();
    expect(sendAgentInput).not.toHaveBeenCalled();
  });

  it("falls through to autoNudge when an overseer exists in metadata but is offline", async () => {
    // overseer marked in metadata but absent from the running/idle session list
    const offlineOverseer = () => state({ a: derived("idle"), boss: meta({ overseer: true }) });

    const observeOnly = watcherDeps({ loadMetadata: offlineOverseer });
    await new LoopWatcher(observeOnly.deps).scan();
    expect(observeOnly.sendAgentInput).not.toHaveBeenCalled();

    const nudging = watcherDeps({
      loadMetadata: offlineOverseer,
      config: { ...config, autoNudgeWithoutOverseer: true },
    });
    await new LoopWatcher(nudging.deps).scan();
    expect(nudging.sendAgentInput).toHaveBeenCalledTimes(1);
    expect(nudging.sendAgentInput.mock.calls[0][0]).toBe("a");
  });

  it("sends a canned nudge per candidate when autoNudge is on, respecting cooldown", async () => {
    const { deps, sendAgentInput, advance } = watcherDeps({
      config: { ...config, autoNudgeWithoutOverseer: true },
    });
    const watcher = new LoopWatcher(deps);

    await watcher.scan();
    expect(sendAgentInput).toHaveBeenCalledTimes(1);
    expect(sendAgentInput.mock.calls[0][0]).toBe("a");
    expect(sendAgentInput.mock.calls[0][1]).toContain("[aimux loop]");
    expect(sendAgentInput.mock.calls[0][1]).toContain("aimux loop done");
    expect(sendAgentInput.mock.calls[0][1]).toContain("aimux loop block");

    await watcher.scan(); // within cooldown
    expect(sendAgentInput).toHaveBeenCalledTimes(1);

    advance(config.nudgeCooldownMs + 1);
    await watcher.scan();
    expect(sendAgentInput).toHaveBeenCalledTimes(2);
  });
});
