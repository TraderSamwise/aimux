import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { DesktopState } from "@/lib/desktop-state";
import { filterWorktreeBucketToActiveEntries, groupByWorktree } from "@/lib/desktop-state";
import {
  applyDesktopStateFailureAtom,
  applyDesktopStateSuccessAtom,
  beginDesktopStateRefreshAtom,
  clearDesktopStateResourceAtom,
  desktopStateErrorFamily,
  desktopStateFamily,
  desktopStateResourceFamily,
} from "./desktopState";

function desktopState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    ok: true,
    sessions: [],
    services: [],
    worktrees: [],
    ...overrides,
  };
}

describe("desktop state resource lifecycle", () => {
  it("uses server-composed worktree groups instead of regrouping raw sessions", () => {
    const groups = groupByWorktree(
      desktopState({
        mainCheckoutInfo: { name: "repo", branch: "main" },
        mainCheckoutPath: "/repo",
        sessions: [
          { id: "raw-extra", status: "running", toolConfigKey: "codex" },
          { id: "canonical", status: "running", toolConfigKey: "claude" },
        ],
        worktreeGroups: [
          {
            name: "Main Checkout",
            branch: "main",
            status: "active",
            sessions: [{ id: "canonical", status: "running", toolConfigKey: "claude" }],
            services: [],
          },
        ],
      }),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["canonical"]);
  });

  it("projects supervisor sessions into their own lane instead of a worktree", () => {
    const groups = groupByWorktree(
      desktopState({
        sessions: [
          {
            id: "overseer-flag",
            status: "running",
            toolConfigKey: "codex",
            role: "overseer",
            lane: { kind: "supervisor" },
            overseer: true,
          },
          {
            id: "overseer-team",
            status: "running",
            toolConfigKey: "claude",
            team: { role: "overseer" },
          },
          {
            id: "agent",
            status: "running",
            toolConfigKey: "codex",
            worktreePath: "/repo/wt",
          },
        ],
        worktrees: [{ name: "wt", path: "/repo/wt", branch: "feature" }],
      }),
    );

    expect(groups[0]).toMatchObject({ isSupervisorLane: true, name: "Supervisor Lane" });
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual([
      "overseer-flag",
      "overseer-team",
    ]);
    expect(groups.flatMap((group) => group.sessions.map((session) => session.id))).toEqual([
      "overseer-flag",
      "overseer-team",
      "agent",
    ]);
  });

  it("uses explicit project-control flags before legacy team roles", () => {
    const groups = groupByWorktree(
      desktopState({
        sessions: [
          {
            id: "stale-role",
            status: "running",
            toolConfigKey: "claude",
            projectControl: false,
            overseer: false,
            team: { role: "overseer" },
          },
          {
            id: "legacy-scribe",
            status: "running",
            toolConfigKey: "claude",
            team: { role: "scribe" },
          },
          { id: "agent", status: "running", toolConfigKey: "codex" },
        ],
      }),
    );

    expect(groups[0]).toMatchObject({ isSupervisorLane: true });
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["legacy-scribe"]);
    expect(groups[1]?.sessions.map((session) => session.id)).toEqual(["stale-role", "agent"]);
  });

  it("uses a future server supervisor lane when present", () => {
    const groups = groupByWorktree(
      desktopState({
        sessions: [
          {
            id: "legacy-copy",
            status: "running",
            toolConfigKey: "codex",
            lane: { kind: "supervisor" },
          },
        ],
        supervisorLane: {
          sessions: [
            {
              id: "server-supervisor",
              status: "running",
              toolConfigKey: "codex",
              role: "overseer",
              lane: { kind: "supervisor" },
            },
          ],
        },
      }),
    );

    expect(groups[0]).toMatchObject({ isSupervisorLane: true });
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["server-supervisor"]);
  });

  it("preserves pending worktree flags through worktree grouping", () => {
    const groups = groupByWorktree(
      desktopState({
        worktrees: [
          {
            name: "feature",
            path: "/repo/.aimux/worktrees/feature",
            branch: "feature",
            pending: true,
          },
          {
            name: "remove-me",
            path: "/repo/.aimux/worktrees/remove-me",
            branch: "remove-me",
            removing: true,
          },
        ],
      }),
    );

    expect(groups[1]).toMatchObject({ name: "feature", pending: true });
    expect(groups[2]).toMatchObject({ name: "remove-me", removing: true });
  });

  it("filters sidebar buckets to active entries like TUI hidden-offline mode", () => {
    const groups = groupByWorktree(
      desktopState({
        mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
        mainCheckoutPath: "/repo",
        worktreeGroups: [
          {
            name: "Main Checkout",
            branch: "main",
            status: "active",
            sessions: [
              { id: "needs-live", status: "running", attention: "needs_input" },
              { id: "stale-needs", status: "offline", attention: "needs_input" },
              { id: "stopped", status: "offline" },
            ],
            services: [{ id: "dead-service", command: "dev", args: [], status: "offline" }],
          },
          {
            name: "dead",
            branch: "dead",
            path: "/repo/.aimux/worktrees/dead",
            status: "offline",
            sessions: [{ id: "only-offline", status: "offline" }],
            services: [],
          },
        ],
      }),
    );

    const shown = groups.flatMap((bucket) => {
      const activeBucket = filterWorktreeBucketToActiveEntries(bucket);
      return activeBucket ? [activeBucket] : [];
    });

    expect(shown).toHaveLength(1);
    expect(shown[0]?.sessions.map((session) => session.id)).toEqual(["needs-live"]);
    expect(shown[0]?.services).toEqual([]);
  });

  it("keeps active supervisor lane entries in the compact sidebar projection", () => {
    const groups = groupByWorktree(
      desktopState({
        sessions: [
          {
            id: "overseer",
            status: "running",
            toolConfigKey: "codex",
            role: "overseer",
            lane: { kind: "supervisor" },
          },
          {
            id: "stopped-scribe",
            status: "offline",
            toolConfigKey: "claude",
            role: "scribe",
            lane: { kind: "supervisor" },
          },
        ],
      }),
    );

    const shown = groups.flatMap((bucket) => {
      const activeBucket = filterWorktreeBucketToActiveEntries(bucket);
      return activeBucket ? [activeBucket] : [];
    });

    expect(shown[0]).toMatchObject({ isSupervisorLane: true });
    expect(shown[0]?.sessions.map((session) => session.id)).toEqual(["overseer"]);
  });

  it("marks an in-flight refresh stale when a previous desktop-state exists", () => {
    const store = createStore();
    const projectPath = "/repo";
    const state = desktopState();

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state,
      updatedAt: 10,
    });
    store.set(beginDesktopStateRefreshAtom, projectPath);

    expect(store.get(desktopStateResourceFamily(projectPath))).toEqual({
      value: state,
      error: null,
      pending: true,
      stale: true,
      updatedAt: 10,
    });
  });

  it("clears stale refresh errors when retrying with a previous desktop-state", () => {
    const store = createStore();
    const projectPath = "/repo";
    const state = desktopState();

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state,
      updatedAt: 10,
    });
    store.set(applyDesktopStateFailureAtom, {
      projectPath,
      error: "request timed out after 10000ms",
    });
    store.set(beginDesktopStateRefreshAtom, projectPath);

    expect(store.get(desktopStateResourceFamily(projectPath))).toMatchObject({
      value: state,
      error: null,
      pending: true,
      stale: true,
    });
  });

  it("keeps last good desktop-state after a critical refresh failure", () => {
    const store = createStore();
    const projectPath = "/repo";
    const state = desktopState();

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state,
      updatedAt: 10,
    });
    store.set(applyDesktopStateFailureAtom, {
      projectPath,
      error: "service unavailable",
    });

    expect(store.get(desktopStateFamily(projectPath))).toBe(state);
    expect(store.get(desktopStateErrorFamily(projectPath))).toBe("service unavailable");
    expect(store.get(desktopStateResourceFamily(projectPath))).toMatchObject({
      value: state,
      error: "service unavailable",
      pending: false,
      stale: true,
    });
  });

  it("clears stale/error metadata after the critical resource recovers", () => {
    const store = createStore();
    const projectPath = "/repo";
    const state = desktopState();
    const recovered = desktopState({
      sessions: [{ id: "agent-1", status: "running", toolConfigKey: "claude" }],
    });

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state,
      updatedAt: 10,
    });
    store.set(applyDesktopStateFailureAtom, {
      projectPath,
      error: "service unavailable",
    });
    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state: recovered,
      updatedAt: 20,
    });

    expect(store.get(desktopStateResourceFamily(projectPath))).toEqual({
      value: recovered,
      error: null,
      pending: false,
      stale: false,
      updatedAt: 20,
    });
  });

  it("clears the resource when the project service endpoint disappears", () => {
    const store = createStore();
    const projectPath = "/repo";

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state: desktopState(),
      updatedAt: 10,
    });
    store.set(clearDesktopStateResourceAtom, projectPath);

    expect(store.get(desktopStateResourceFamily(projectPath))).toEqual({
      value: null,
      error: null,
      pending: false,
      stale: false,
      updatedAt: null,
    });
  });
});
