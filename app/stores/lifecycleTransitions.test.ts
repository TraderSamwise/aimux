import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { DesktopState } from "@/lib/desktop-state";
import type {
  ProjectLifecycleTransition,
  ProjectLifecycleTransitionOperation,
} from "../../src/project-api-contract";
import { applyDesktopStateSuccessAtom, desktopStateFamily } from "./desktopState";
import {
  applyProjectLifecycleTransitionsToDesktopState,
  projectLifecycleTransitionsFamily,
  recordProjectLifecycleTransitionAtom,
} from "./lifecycleTransitions";

function desktopState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    ok: true,
    sessions: [],
    services: [],
    worktrees: [],
    ...overrides,
  };
}

function transition(
  operation: ProjectLifecycleTransitionOperation,
  targetId: string,
  targetKind: ProjectLifecycleTransition["targetKind"] = "agent",
  targetPath?: string,
  phase: ProjectLifecycleTransition["phase"] = "started",
): ProjectLifecycleTransition {
  return {
    operationId: `${operation}:${targetId}`,
    operation,
    targetKind,
    targetId,
    targetPath,
    phase,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("project lifecycle transition projection", () => {
  it("overlays an in-flight agent resume over stale desktop-state", () => {
    const state = desktopState({
      sessions: [{ id: "agent-1", label: "claude", status: "offline" }],
    });

    const projected = applyProjectLifecycleTransitionsToDesktopState(state, [
      {
        transition: transition("agent.resume", "agent-1"),
        label: "claude",
        tool: "claude",
      },
    ]);

    expect(projected?.sessions[0]).toMatchObject({
      id: "agent-1",
      status: "waiting",
      pendingAction: "starting",
      optimistic: true,
    });
    expect(state.sessions[0]).toEqual({ id: "agent-1", label: "claude", status: "offline" });
  });

  it("adds optimistic agent rows before the next desktop-state includes them", () => {
    const projected = applyProjectLifecycleTransitionsToDesktopState(desktopState(), [
      {
        transition: transition("agent.spawn", "agent-2", "agent", "/repo/.aimux/worktrees/feature"),
        label: "agent-2",
        tool: "codex",
        worktreePath: "/repo/.aimux/worktrees/feature",
      },
    ]);

    expect(projected?.sessions).toEqual([
      {
        id: "agent-2",
        label: "agent-2",
        command: "codex",
        toolConfigKey: "codex",
        worktreePath: "/repo/.aimux/worktrees/feature",
        status: "waiting",
        pendingAction: "starting",
        optimistic: true,
      },
    ]);
  });

  it("settles agent transitions only after desktop-state reaches the target state", () => {
    const store = createStore();
    const projectPath = "/repo";

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state: desktopState({
        sessions: [{ id: "agent-1", label: "claude", status: "offline" }],
      }),
    });
    store.set(recordProjectLifecycleTransitionAtom, {
      projectPath,
      transition: transition("agent.resume", "agent-1"),
      label: "claude",
      tool: "claude",
    });

    expect(store.get(desktopStateFamily(projectPath))?.sessions[0]).toMatchObject({
      id: "agent-1",
      status: "waiting",
      pendingAction: "starting",
    });

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state: desktopState({
        sessions: [{ id: "agent-1", label: "claude", status: "offline" }],
      }),
    });

    expect(store.get(projectLifecycleTransitionsFamily(projectPath))).toHaveLength(1);

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state: desktopState({
        sessions: [{ id: "agent-1", label: "claude", status: "running" }],
      }),
    });

    expect(store.get(projectLifecycleTransitionsFamily(projectPath))).toHaveLength(0);
    expect(store.get(desktopStateFamily(projectPath))?.sessions[0]).toMatchObject({
      id: "agent-1",
      status: "running",
    });
    expect(store.get(desktopStateFamily(projectPath))?.sessions[0]?.pendingAction).toBeUndefined();
  });

  it("records succeeded transitions until fresh desktop-state proves settlement", () => {
    const store = createStore();
    const projectPath = "/repo";

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state: desktopState({
        sessions: [{ id: "agent-1", label: "claude", status: "offline" }],
      }),
    });
    store.set(recordProjectLifecycleTransitionAtom, {
      projectPath,
      transition: transition("agent.resume", "agent-1", "agent", undefined, "succeeded"),
      label: "claude",
      tool: "claude",
    });

    expect(store.get(projectLifecycleTransitionsFamily(projectPath))).toHaveLength(1);
    expect(store.get(desktopStateFamily(projectPath))?.sessions[0]).toMatchObject({
      id: "agent-1",
      pendingAction: "starting",
    });
  });

  it("clears an existing transition when the operation fails", () => {
    const store = createStore();
    const projectPath = "/repo";

    store.set(recordProjectLifecycleTransitionAtom, {
      projectPath,
      transition: transition("agent.resume", "agent-1"),
      label: "claude",
      tool: "claude",
    });
    store.set(recordProjectLifecycleTransitionAtom, {
      projectPath,
      transition: transition("agent.resume", "agent-1", "agent", undefined, "failed"),
      label: "claude",
      tool: "claude",
    });

    expect(store.get(projectLifecycleTransitionsFamily(projectPath))).toHaveLength(0);
  });

  it("updates agent rename labels optimistically", () => {
    const projected = applyProjectLifecycleTransitionsToDesktopState(
      desktopState({
        sessions: [{ id: "agent-1", label: "old", status: "running" }],
      }),
      [
        {
          transition: transition("agent.rename", "agent-1"),
          label: "new",
        },
      ],
    );

    expect(projected?.sessions[0]).toMatchObject({
      id: "agent-1",
      label: "new",
      pendingAction: "renaming",
      optimistic: true,
    });
  });

  it("projects worktree create and remove transitions onto worktree state", () => {
    const state = desktopState({
      worktrees: [{ name: "old", path: "/repo/.aimux/worktrees/old", branch: "old" }],
    });

    const projected = applyProjectLifecycleTransitionsToDesktopState(state, [
      {
        transition: transition(
          "worktree.create",
          "feature",
          "worktree",
          "/repo/.aimux/worktrees/feature",
        ),
        worktreeName: "feature",
        worktreePath: "/repo/.aimux/worktrees/feature",
      },
      {
        transition: transition("worktree.remove", "old", "worktree", "/repo/.aimux/worktrees/old"),
        worktreePath: "/repo/.aimux/worktrees/old",
      },
    ]);

    expect(projected?.worktrees).toEqual([
      {
        name: "old",
        path: "/repo/.aimux/worktrees/old",
        branch: "old",
        removing: true,
      },
      {
        name: "feature",
        path: "/repo/.aimux/worktrees/feature",
        branch: "feature",
        pending: true,
      },
    ]);
  });

  it("keeps removed worktrees marked while dependent rows are still settling", () => {
    const store = createStore();
    const projectPath = "/repo";
    const path = "/repo/.aimux/worktrees/old";

    store.set(recordProjectLifecycleTransitionAtom, {
      projectPath,
      transition: transition("worktree.remove", "old", "worktree", path, "settling"),
      worktreePath: path,
    });
    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state: desktopState({
        sessions: [{ id: "agent-1", label: "codex", status: "offline", worktreePath: path }],
        worktrees: [],
      }),
    });

    expect(store.get(projectLifecycleTransitionsFamily(projectPath))).toHaveLength(1);
    expect(store.get(desktopStateFamily(projectPath))?.worktrees).toEqual([
      { name: "old", path, branch: "old", removing: true },
    ]);

    store.set(applyDesktopStateSuccessAtom, {
      projectPath,
      state: desktopState({ sessions: [], services: [], worktrees: [] }),
    });

    expect(store.get(projectLifecycleTransitionsFamily(projectPath))).toHaveLength(0);
    expect(store.get(desktopStateFamily(projectPath))?.worktrees ?? []).toEqual([]);
  });

  it("projects worktree resurrect transitions like worktree creation", () => {
    const path = "/repo/.aimux/worktrees/restored";
    const projected = applyProjectLifecycleTransitionsToDesktopState(desktopState(), [
      {
        transition: transition("graveyard.worktree.resurrect", "restored", "worktree", path),
        worktreeName: "restored",
        worktreePath: path,
      },
    ]);

    expect(projected?.worktrees).toEqual([
      {
        name: "restored",
        path,
        branch: "restored",
        pending: true,
      },
    ]);
  });

  it("overlays service transitions without exposing offline actions for active transitions", () => {
    const state = desktopState({
      services: [{ id: "svc-1", label: "server", status: "running" }],
    });

    const stopping = applyProjectLifecycleTransitionsToDesktopState(state, [
      {
        transition: transition("service.stop", "svc-1", "service"),
        label: "server",
      },
    ]);
    const resuming = applyProjectLifecycleTransitionsToDesktopState(
      desktopState({
        services: [{ id: "svc-1", label: "server", status: "offline" }],
      }),
      [
        {
          transition: transition("service.resume", "svc-1", "service"),
          label: "server",
        },
      ],
    );

    expect(stopping?.services[0]).toMatchObject({
      id: "svc-1",
      status: "running",
      pendingAction: "stopping",
      optimistic: true,
    });
    expect(resuming?.services[0]).toMatchObject({
      id: "svc-1",
      status: "running",
      pendingAction: "starting",
      optimistic: true,
    });
    expect(state.services[0]).toEqual({ id: "svc-1", label: "server", status: "running" });
  });

  it("adds optimistic service rows before the next desktop-state includes them", () => {
    const projected = applyProjectLifecycleTransitionsToDesktopState(desktopState(), [
      {
        transition: transition("service.create", "svc-2", "service", "/repo/worktree"),
        label: "server",
        worktreePath: "/repo/worktree",
      },
    ]);

    expect(projected?.services).toEqual([
      {
        id: "svc-2",
        label: "server",
        worktreePath: "/repo/worktree",
        status: "running",
        pendingAction: "starting",
        optimistic: true,
      },
    ]);
  });
});
