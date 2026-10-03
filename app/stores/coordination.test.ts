import { createStore } from "jotai";
import { projectStateKey } from "@/lib/project-key";
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
  isCurrentCoordinationWorklistRequest,
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
    const stateKey = projectStateKey({ path: "/repo" });
    const current = worklist();

    store.set(applyCoordinationWorklistSuccessAtom, {
      projectStateKey: stateKey,
      worklist: current,
      updatedAt: 10,
    });
    store.set(beginCoordinationWorklistRefreshAtom, stateKey);

    expect(store.get(coordinationWorklistResourceFamily(stateKey))).toEqual({
      value: current,
      error: null,
      pending: true,
      stale: true,
      updatedAt: 10,
    });
  });

  it("keeps the last good worklist after a refresh failure", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = worklist();

    store.set(applyCoordinationWorklistSuccessAtom, {
      projectStateKey: stateKey,
      worklist: current,
      updatedAt: 10,
    });
    store.set(applyCoordinationWorklistFailureAtom, {
      projectStateKey: stateKey,
      error: "service unavailable",
    });

    expect(store.get(coordinationWorklistFamily(stateKey))).toBe(current);
    expect(store.get(coordinationWorklistErrorFamily(stateKey))).toBe("service unavailable");
    expect(store.get(coordinationWorklistResourceFamily(stateKey))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      stale: true,
    });
  });

  it("clears stale/error metadata after the worklist recovers", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = worklist();
    const recovered = worklist({ items: [item("notice-2")] });

    store.set(applyCoordinationWorklistSuccessAtom, {
      projectStateKey: stateKey,
      worklist: current,
      updatedAt: 10,
    });
    store.set(applyCoordinationWorklistFailureAtom, {
      projectStateKey: stateKey,
      error: "service unavailable",
    });
    store.set(applyCoordinationWorklistSuccessAtom, {
      projectStateKey: stateKey,
      worklist: recovered,
      updatedAt: 20,
    });

    expect(store.get(coordinationWorklistResourceFamily(stateKey))).toEqual({
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

    store.set(applyCoordinationWorklistSuccessAtom, {
      projectStateKey: stateKey,
      worklist: worklist(),
      updatedAt: 10,
    });
    store.set(clearCoordinationWorklistResourceAtom, stateKey);

    expect(store.get(coordinationWorklistResourceFamily(stateKey))).toEqual({
      value: null,
      error: null,
      pending: false,
      stale: false,
      updatedAt: null,
    });
  });

  it("rejects in-flight worklist results from an old endpoint generation", () => {
    expect(
      isCurrentCoordinationWorklistRequest(
        {
          projectStateKey: projectStateKey({ path: "/repo" }),
          endpointKey: "127.0.0.1:43190",
          generation: 1,
        },
        {
          projectStateKey: projectStateKey({ path: "/repo" }),
          endpointKey: "127.0.0.1:43191",
          generation: 2,
        },
      ),
    ).toBe(false);

    expect(
      isCurrentCoordinationWorklistRequest(
        {
          projectStateKey: projectStateKey({ path: "/repo" }),
          endpointKey: "127.0.0.1:43191",
          generation: 2,
        },
        {
          projectStateKey: projectStateKey({ path: "/repo" }),
          endpointKey: "127.0.0.1:43191",
          generation: 2,
        },
      ),
    ).toBe(true);
  });
});
