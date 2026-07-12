import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { DesktopState } from "@/lib/desktop-state";
import { groupByWorktree } from "@/lib/desktop-state";
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
