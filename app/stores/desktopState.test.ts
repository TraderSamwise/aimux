import { createStore } from "jotai";
import { projectStateKey } from "@/lib/project-key";
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
  worktreeGroupsFamily,
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
            id: "agent",
            status: "running",
            toolConfigKey: "codex",
            worktreePath: "/repo/wt",
          },
        ],
        supervisorLane: {
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
              id: "scribe-control",
              status: "running",
              toolConfigKey: "claude",
              role: "scribe",
              lane: { kind: "supervisor" },
              scribe: true,
              projectControl: true,
            },
          ],
        },
        worktreeGroups: [
          {
            name: "wt",
            path: "/repo/wt",
            branch: "feature",
            status: "active",
            sessions: [
              {
                id: "agent",
                status: "running",
                toolConfigKey: "codex",
                worktreePath: "/repo/wt",
              },
            ],
            services: [],
          },
        ],
        worktrees: [{ name: "wt", path: "/repo/wt", branch: "feature" }],
      }),
    );

    expect(groups[0]).toMatchObject({ isSupervisorLane: true, name: "Supervisor Lane" });
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual([
      "overseer-flag",
      "scribe-control",
    ]);
    expect(groups.flatMap((group) => group.sessions.map((session) => session.id))).toEqual([
      "overseer-flag",
      "scribe-control",
      "agent",
    ]);
  });

  it("does not synthesize a supervisor lane when relay payload omits the field", () => {
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
            role: "scribe",
            team: { role: "scribe" },
          },
          { id: "agent", status: "running", toolConfigKey: "codex" },
        ],
      }),
    );

    expect(groups.some((group) => group.isSupervisorLane)).toBe(false);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual([
      "stale-role",
      "legacy-scribe",
      "agent",
    ]);
  });

  // The server emits `lane` on every session, and the plane is what decides
  // which lane a session renders in. Falling back to projectControl here meant
  // an agent moved out of the supervisor plane was hidden from its worktree
  // group as well, leaving it in no lane at all.
  it("keeps supervisor-plane sessions in the supervisor lane", () => {
    const groups = groupByWorktree(
      desktopState({
        sessions: [
          {
            id: "qa-supervisor",
            status: "running",
            toolConfigKey: "codex",
            projectControl: true,
            lane: { kind: "supervisor" },
            role: "qa",
            team: { role: "qa" },
          },
          {
            id: "ordinary-qa-teammate",
            status: "running",
            toolConfigKey: "codex",
            role: "qa",
            team: { role: "qa" },
          },
        ],
        supervisorLane: {
          sessions: [
            {
              id: "qa-supervisor",
              status: "running",
              toolConfigKey: "codex",
              projectControl: true,
              lane: { kind: "supervisor" },
              role: "qa",
              team: { role: "qa" },
            },
          ],
        },
      }),
    );

    expect(groups[0]).toMatchObject({ isSupervisorLane: true });
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["qa-supervisor"]);
    expect(groups[1]?.sessions.map((session) => session.id)).toEqual(["ordinary-qa-teammate"]);
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
        supervisorLane: {
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
        },
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
    const stateKey = projectStateKey({ path: "/repo" });
    const state = desktopState();

    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: stateKey,
      state,
      updatedAt: 10,
    });
    store.set(beginDesktopStateRefreshAtom, stateKey);

    expect(store.get(desktopStateResourceFamily(stateKey))).toEqual({
      value: state,
      error: null,
      pending: true,
      stale: true,
      updatedAt: 10,
    });
  });

  it("clears stale refresh errors when retrying with a previous desktop-state", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const state = desktopState();

    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: stateKey,
      state,
      updatedAt: 10,
    });
    store.set(applyDesktopStateFailureAtom, {
      projectStateKey: stateKey,
      error: "request timed out after 10000ms",
    });
    store.set(beginDesktopStateRefreshAtom, stateKey);

    expect(store.get(desktopStateResourceFamily(stateKey))).toMatchObject({
      value: state,
      error: null,
      pending: true,
      stale: true,
    });
  });

  it("keeps last good desktop-state after a critical refresh failure", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const state = desktopState();

    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: stateKey,
      state,
      updatedAt: 10,
    });
    store.set(applyDesktopStateFailureAtom, {
      projectStateKey: stateKey,
      error: "service unavailable",
    });

    expect(store.get(desktopStateFamily(stateKey))).toBe(state);
    expect(store.get(desktopStateErrorFamily(stateKey))).toBe("service unavailable");
    expect(store.get(desktopStateResourceFamily(stateKey))).toMatchObject({
      value: state,
      error: "service unavailable",
      pending: false,
      stale: true,
    });
  });

  it("clears stale/error metadata after the critical resource recovers", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const state = desktopState();
    const recovered = desktopState({
      sessions: [{ id: "agent-1", status: "running", toolConfigKey: "claude" }],
    });

    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: stateKey,
      state,
      updatedAt: 10,
    });
    store.set(applyDesktopStateFailureAtom, {
      projectStateKey: stateKey,
      error: "service unavailable",
    });
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: stateKey,
      state: recovered,
      updatedAt: 20,
    });

    expect(store.get(desktopStateResourceFamily(stateKey))).toEqual({
      value: recovered,
      error: null,
      pending: false,
      stale: false,
      updatedAt: 20,
    });
  });

  it("clears the resource when the project service endpoint disappears", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });

    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: stateKey,
      state: desktopState(),
      updatedAt: 10,
    });
    store.set(clearDesktopStateResourceAtom, stateKey);

    expect(store.get(desktopStateResourceFamily(stateKey))).toEqual({
      value: null,
      error: null,
      pending: false,
      stale: false,
      updatedAt: null,
    });
  });
});

// The whole agent list used to rebuild on every poll, because the daemon rebuilds
// the payload each time and the store kept whatever it was handed. Measured at
// ~120ms per tick for 35 agents, three times per data change, for output that was
// byte-identical. These pin the identity rules that stopped it.
describe("a poll that changes nothing must not invalidate the view", () => {
  const populated = () =>
    desktopState({
      mainCheckoutPath: "/repo",
      mainCheckoutInfo: { name: "repo", branch: "main" },
      sessions: [
        { id: "a", status: "running", toolConfigKey: "claude" },
        { id: "b", status: "running", toolConfigKey: "codex" },
      ],
      worktreeGroups: [
        {
          name: "repo",
          path: "/repo",
          branch: "main",
          status: "active",
          sessions: [
            { id: "a", status: "running", toolConfigKey: "claude" },
            { id: "b", status: "running", toolConfigKey: "codex" },
          ],
          services: [],
        },
      ],
    });

  it("keeps the previous state object when the payload is identical", () => {
    const store = createStore();
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: projectStateKey({ path: "/repo" }),
      state: populated(),
    });
    const first = store.get(desktopStateFamily(projectStateKey({ path: "/repo" })));

    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: projectStateKey({ path: "/repo" }),
      state: populated(),
    });

    expect(store.get(desktopStateFamily(projectStateKey({ path: "/repo" })))).toBe(first);
  });

  it("does not regroup when only a field the view never renders changed", () => {
    const store = createStore();
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: projectStateKey({ path: "/repo" }),
      state: populated(),
    });
    const groupsBefore = store.get(worktreeGroupsFamily(projectStateKey({ path: "/repo" })));

    // loopAlertState is shipped by the daemon, read by nothing in the app, and
    // changed on nearly every poll. It must not cost a single row render.
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: projectStateKey({ path: "/repo" }),
      state: { ...populated(), loopAlertState: { changed: Date.now() } } as DesktopState,
    });

    expect(store.get(worktreeGroupsFamily(projectStateKey({ path: "/repo" })))).toBe(groupsBefore);
  });

  it("keeps unchanged sessions identical when one session changes", () => {
    const store = createStore();
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: projectStateKey({ path: "/repo" }),
      state: populated(),
    });
    const before = store.get(desktopStateFamily(projectStateKey({ path: "/repo" })));

    const next = populated();
    next.sessions[1] = { ...next.sessions[1], status: "idle" };
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: projectStateKey({ path: "/repo" }),
      state: next,
    });
    const after = store.get(desktopStateFamily(projectStateKey({ path: "/repo" })));

    expect(after).not.toBe(before);
    expect(after?.sessions[0]).toBe(before?.sessions[0]);
    expect(after?.sessions[1]).not.toBe(before?.sessions[1]);
    expect(after?.sessions[1]?.status).toBe("idle");
  });
});

// Memoisation's failure mode is a screen that stops updating, so the cases where
// a wrongly-held reference would show as "nothing happened" are pinned here too.
describe("changes still reach the view", () => {
  const withSessions = (sessions: DesktopState["sessions"]): DesktopState =>
    desktopState({
      mainCheckoutPath: "/repo",
      mainCheckoutInfo: { name: "repo", branch: "main" },
      sessions,
      worktreeGroups: [
        {
          name: "repo",
          path: "/repo",
          branch: "main",
          status: "active",
          sessions,
          services: [],
        },
      ],
    });

  const session = (id: string, status: DesktopState["sessions"][number]["status"] = "running") => ({
    id,
    status,
    toolConfigKey: "claude",
  });

  function apply(store: ReturnType<typeof createStore>, sessions: DesktopState["sessions"]) {
    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: projectStateKey({ path: "/repo" }),
      state: withSessions(sessions),
    });
    return store.get(worktreeGroupsFamily(projectStateKey({ path: "/repo" })));
  }

  it("regroups when an agent changes status", () => {
    const store = createStore();
    const before = apply(store, [session("a"), session("b")]);
    const after = apply(store, [session("a"), session("b", "idle")]);

    expect(after).not.toBe(before);
    const bucket = after.find((group) => group.path === "/repo");
    expect(bucket?.sessions.find((s) => s.id === "b")?.status).toBe("idle");
  });

  it("regroups when an agent is added", () => {
    const store = createStore();
    const before = apply(store, [session("a")]);
    const after = apply(store, [session("a"), session("b")]);

    expect(after).not.toBe(before);
    expect(after.find((g) => g.path === "/repo")?.sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("regroups when an agent disappears", () => {
    const store = createStore();
    const before = apply(store, [session("a"), session("b")]);
    const after = apply(store, [session("a")]);

    expect(after).not.toBe(before);
    expect(after.find((g) => g.path === "/repo")?.sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("regroups when agents are reordered, even though every entry is unchanged", () => {
    const store = createStore();
    const before = apply(store, [session("a"), session("b")]);
    const after = apply(store, [session("b"), session("a")]);

    expect(after).not.toBe(before);
    expect(after.find((g) => g.path === "/repo")?.sessions.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("surfaces an error after a successful state without clearing the state", () => {
    const store = createStore();
    apply(store, [session("a")]);
    store.set(applyDesktopStateFailureAtom, {
      projectStateKey: projectStateKey({ path: "/repo" }),
      error: "host offline",
    });

    expect(store.get(desktopStateErrorFamily(projectStateKey({ path: "/repo" })))).toBe(
      "host offline",
    );
    expect(
      store.get(desktopStateFamily(projectStateKey({ path: "/repo" })))?.sessions,
    ).toHaveLength(1);
  });
});

describe("two machines holding the same checkout", () => {
  // The families used to take a bare path, so these two shared one atom: the
  // mbp's agent list showed up under strix's project until the next poll.
  it("keeps their desktop state apart", () => {
    const store = createStore();
    const mbp = projectStateKey({ machineId: "mbp", path: "/repo/aimux" });
    const strix = projectStateKey({ machineId: "strix", path: "/repo/aimux" });

    store.set(applyDesktopStateSuccessAtom, {
      projectStateKey: mbp,
      state: { ok: true, sessions: [], teammates: [], services: [], worktrees: [] },
    });

    expect(store.get(desktopStateFamily(mbp))).not.toBeNull();
    expect(store.get(desktopStateFamily(strix))).toBeNull();
  });

  it("keeps their errors apart", () => {
    const store = createStore();
    const mbp = projectStateKey({ machineId: "mbp", path: "/repo/aimux" });
    const strix = projectStateKey({ machineId: "strix", path: "/repo/aimux" });

    store.set(applyDesktopStateFailureAtom, { projectStateKey: mbp, error: "mbp is unreachable" });

    expect(store.get(desktopStateErrorFamily(mbp))).toBe("mbp is unreachable");
    expect(store.get(desktopStateErrorFamily(strix))).toBeNull();
  });
});
