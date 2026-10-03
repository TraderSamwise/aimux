import { createStore } from "jotai";
import { projectStateKey } from "@/lib/project-key";
import { describe, expect, it } from "vitest";

import {
  applyTopologyFailureAtom,
  applyTopologySuccessAtom,
  beginTopologyRefreshAtom,
  clearTopologyResourceAtom,
  isCurrentTopologyRequest,
  settleTopologyRefreshAtom,
  topologyErrorFamily,
  topologyFamily,
  topologyResourceFamily,
  type TopologyValue,
} from "./topology";

function topology(overrides: Partial<TopologyValue> = {}): TopologyValue {
  return {
    projectName: "repo",
    health: "idle",
    counts: {
      worktrees: 1,
      agents: 1,
      services: 0,
    },
    worktrees: [
      {
        name: "Main Checkout",
        path: "/repo",
        branch: "main",
        health: "idle",
        agents: 1,
        services: 0,
      },
    ],
    rows: [
      {
        kind: "agent",
        depth: 1,
        label: "claude",
        health: "idle",
        status: "ready",
        sessionId: "agent-1",
      },
    ],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("topology resource lifecycle", () => {
  it("marks an in-flight refresh stale when a previous topology exists", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = topology();

    store.set(applyTopologySuccessAtom, {
      projectStateKey: stateKey,
      topology: current,
      updatedAt: 10,
    });
    store.set(beginTopologyRefreshAtom, stateKey);

    expect(store.get(topologyResourceFamily(stateKey))).toEqual({
      value: current,
      error: null,
      pending: true,
      stale: true,
      updatedAt: 10,
    });
  });

  it("keeps the last good topology after a refresh failure", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = topology();

    store.set(applyTopologySuccessAtom, {
      projectStateKey: stateKey,
      topology: current,
      updatedAt: 10,
    });
    store.set(applyTopologyFailureAtom, {
      projectStateKey: stateKey,
      error: "service unavailable",
    });

    expect(store.get(topologyFamily(stateKey))).toBe(current);
    expect(store.get(topologyErrorFamily(stateKey))).toBe("service unavailable");
    expect(store.get(topologyResourceFamily(stateKey))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      stale: true,
    });
  });

  it("settles transient refreshes without surfacing a stale failure", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = topology();

    store.set(applyTopologySuccessAtom, {
      projectStateKey: stateKey,
      topology: current,
      updatedAt: 10,
    });
    store.set(beginTopologyRefreshAtom, stateKey);
    store.set(settleTopologyRefreshAtom, stateKey);

    expect(store.get(topologyResourceFamily(stateKey))).toEqual({
      value: current,
      error: null,
      pending: false,
      stale: true,
      updatedAt: 10,
    });
  });

  it("clears stale/error metadata after the topology recovers", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = topology();
    const recovered = topology({ counts: { worktrees: 1, agents: 2, services: 0 } });

    store.set(applyTopologySuccessAtom, {
      projectStateKey: stateKey,
      topology: current,
      updatedAt: 10,
    });
    store.set(applyTopologyFailureAtom, {
      projectStateKey: stateKey,
      error: "service unavailable",
    });
    store.set(applyTopologySuccessAtom, {
      projectStateKey: stateKey,
      topology: recovered,
      updatedAt: 20,
    });

    expect(store.get(topologyResourceFamily(stateKey))).toEqual({
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

    store.set(applyTopologySuccessAtom, {
      projectStateKey: stateKey,
      topology: topology(),
      updatedAt: 10,
    });
    store.set(clearTopologyResourceAtom, stateKey);

    expect(store.get(topologyResourceFamily(stateKey))).toEqual({
      value: null,
      error: null,
      pending: false,
      stale: false,
      updatedAt: null,
    });
  });

  it("rejects in-flight topology results from an old endpoint generation", () => {
    expect(
      isCurrentTopologyRequest(
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
      isCurrentTopologyRequest(
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
