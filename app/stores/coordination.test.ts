import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { CoordinationWorklistItem } from "@/lib/api";
import {
  applyCoordinationWorklistFailureAtom,
  applyCoordinationWorklistSuccessAtom,
  beginCoordinationWorklistRefreshAtom,
  clearCoordinationWorklistResourceAtom,
  coordinationWorklistErrorFamily,
  coordinationWorklistFamily,
  coordinationWorklistResourceFamily,
  type CoordinationWorklistValue,
} from "./coordination";

function item(key: string): CoordinationWorklistItem {
  return {
    key,
    kind: "notification",
    type: "msg",
    bucket: "awake",
    title: "Needs input",
    urgency: 10,
    reachability: "live",
    actionable: true,
    stale: false,
    sessionId: "agent-1",
  };
}

function worklist(overrides: Partial<CoordinationWorklistValue> = {}): CoordinationWorklistValue {
  return {
    items: [item("notice-1")],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("coordination worklist resource lifecycle", () => {
  it("marks an in-flight refresh stale when a previous worklist exists", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = worklist();

    store.set(applyCoordinationWorklistSuccessAtom, {
      projectPath,
      worklist: current,
      updatedAt: 10,
    });
    store.set(beginCoordinationWorklistRefreshAtom, projectPath);

    expect(store.get(coordinationWorklistResourceFamily(projectPath))).toEqual({
      value: current,
      error: null,
      pending: true,
      stale: true,
      updatedAt: 10,
    });
  });

  it("keeps the last good worklist after a refresh failure", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = worklist();

    store.set(applyCoordinationWorklistSuccessAtom, {
      projectPath,
      worklist: current,
      updatedAt: 10,
    });
    store.set(applyCoordinationWorklistFailureAtom, {
      projectPath,
      error: "service unavailable",
    });

    expect(store.get(coordinationWorklistFamily(projectPath))).toBe(current);
    expect(store.get(coordinationWorklistErrorFamily(projectPath))).toBe("service unavailable");
    expect(store.get(coordinationWorklistResourceFamily(projectPath))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      stale: true,
    });
  });

  it("clears stale/error metadata after the worklist recovers", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = worklist();
    const recovered = worklist({ items: [item("notice-2")] });

    store.set(applyCoordinationWorklistSuccessAtom, {
      projectPath,
      worklist: current,
      updatedAt: 10,
    });
    store.set(applyCoordinationWorklistFailureAtom, {
      projectPath,
      error: "service unavailable",
    });
    store.set(applyCoordinationWorklistSuccessAtom, {
      projectPath,
      worklist: recovered,
      updatedAt: 20,
    });

    expect(store.get(coordinationWorklistResourceFamily(projectPath))).toEqual({
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

    store.set(applyCoordinationWorklistSuccessAtom, {
      projectPath,
      worklist: worklist(),
      updatedAt: 10,
    });
    store.set(clearCoordinationWorklistResourceAtom, projectPath);

    expect(store.get(coordinationWorklistResourceFamily(projectPath))).toEqual({
      value: null,
      error: null,
      pending: false,
      stale: false,
      updatedAt: null,
    });
  });
});
