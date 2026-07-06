import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { TaskSummaryResponse } from "@/lib/api";
import {
  applyProjectObservabilityFailureAtom,
  applyProjectObservabilitySuccessAtom,
  applyProjectTasksFailureAtom,
  applyProjectTasksSuccessAtom,
  beginProjectObservabilityRefreshAtom,
  beginProjectTasksRefreshAtom,
  clearProjectObservabilityResourceAtom,
  clearProjectTasksResourceAtom,
  emptyProjectObservability,
  isCurrentProjectResourceRequest,
  projectObservabilityFamily,
  projectObservabilityResourceFamily,
  projectResourceRequestKey,
  projectTasksFamily,
  projectTasksResourceFamily,
  settleProjectObservabilityRefreshAtom,
  settleProjectTasksRefreshAtom,
  type ProjectObservabilityValue,
  type ProjectTasksValue,
} from "./project";

function observability(
  overrides: Partial<ProjectObservabilityValue> = {},
): ProjectObservabilityValue {
  return {
    project: {
      ...emptyProjectObservability(),
      summary: {
        ...emptyProjectObservability().summary,
        agentsRunning: 1,
        openTasks: 1,
      },
    },
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function task(id: string): TaskSummaryResponse {
  return {
    id,
    description: "Ship the thing",
    status: "assigned",
    assignedTo: "claude",
    tool: "claude",
  };
}

function tasks(overrides: Partial<ProjectTasksValue> = {}): ProjectTasksValue {
  return {
    tasks: [task("task-1")],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("project resource lifecycle", () => {
  it("keeps stale project observability after a refresh failure", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = observability();

    store.set(applyProjectObservabilitySuccessAtom, {
      projectPath,
      observability: current,
      updatedAt: 10,
    });
    store.set(beginProjectObservabilityRefreshAtom, { projectPath, requestKey: "request-1" });
    store.set(applyProjectObservabilityFailureAtom, {
      projectPath,
      error: "service unavailable",
    });

    expect(store.get(projectObservabilityFamily(projectPath))).toBe(current);
    expect(store.get(projectObservabilityResourceFamily(projectPath))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("keeps stale project tasks after a refresh failure", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = tasks();

    store.set(applyProjectTasksSuccessAtom, {
      projectPath,
      tasks: current,
      updatedAt: 10,
    });
    store.set(beginProjectTasksRefreshAtom, { projectPath, requestKey: "request-1" });
    store.set(applyProjectTasksFailureAtom, {
      projectPath,
      error: "service unavailable",
    });

    expect(store.get(projectTasksFamily(projectPath))).toBe(current);
    expect(store.get(projectTasksResourceFamily(projectPath))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("clears stale/error metadata after both project resources recover", () => {
    const store = createStore();
    const projectPath = "/repo";
    const recoveredObservability = observability({
      project: {
        ...emptyProjectObservability(),
        summary: {
          ...emptyProjectObservability().summary,
          agentsRunning: 2,
        },
      },
    });
    const recoveredTasks = tasks({ tasks: [task("task-2")] });

    store.set(applyProjectObservabilityFailureAtom, {
      projectPath,
      error: "service unavailable",
    });
    store.set(applyProjectTasksFailureAtom, {
      projectPath,
      error: "service unavailable",
    });
    store.set(applyProjectObservabilitySuccessAtom, {
      projectPath,
      observability: recoveredObservability,
      updatedAt: 20,
    });
    store.set(applyProjectTasksSuccessAtom, {
      projectPath,
      tasks: recoveredTasks,
      updatedAt: 20,
    });

    expect(store.get(projectObservabilityResourceFamily(projectPath))).toEqual({
      value: recoveredObservability,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: 20,
    });
    expect(store.get(projectTasksResourceFamily(projectPath))).toEqual({
      value: recoveredTasks,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: 20,
    });
  });

  it("clears project resources when the project service endpoint disappears", () => {
    const store = createStore();
    const projectPath = "/repo";

    store.set(applyProjectObservabilitySuccessAtom, {
      projectPath,
      observability: observability(),
      updatedAt: 10,
    });
    store.set(applyProjectTasksSuccessAtom, {
      projectPath,
      tasks: tasks(),
      updatedAt: 10,
    });
    store.set(clearProjectObservabilityResourceAtom, projectPath);
    store.set(clearProjectTasksResourceAtom, projectPath);

    expect(store.get(projectObservabilityResourceFamily(projectPath))).toEqual({
      value: null,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: null,
    });
    expect(store.get(projectTasksResourceFamily(projectPath))).toEqual({
      value: null,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: null,
    });
  });

  it("rejects in-flight project resource results from an old endpoint generation", () => {
    expect(
      isCurrentProjectResourceRequest(
        { projectPath: "/repo", endpointKey: "127.0.0.1:43190", generation: 1 },
        { projectPath: "/repo", endpointKey: "127.0.0.1:43191", generation: 2 },
      ),
    ).toBe(false);

    expect(
      isCurrentProjectResourceRequest(
        { projectPath: "/repo", endpointKey: "127.0.0.1:43191", generation: 2 },
        { projectPath: "/repo", endpointKey: "127.0.0.1:43191", generation: 2 },
      ),
    ).toBe(true);
  });

  it("settles only the pending project observability request that owns the marker", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = observability();
    const staleRequest = projectResourceRequestKey(
      { projectPath, endpointKey: "127.0.0.1:43190", generation: 1 },
      1,
    );
    const currentRequest = projectResourceRequestKey(
      { projectPath, endpointKey: "127.0.0.1:43191", generation: 2 },
      2,
    );

    store.set(applyProjectObservabilitySuccessAtom, {
      projectPath,
      observability: current,
      updatedAt: 10,
    });
    store.set(beginProjectObservabilityRefreshAtom, { projectPath, requestKey: staleRequest });
    store.set(beginProjectObservabilityRefreshAtom, { projectPath, requestKey: currentRequest });
    store.set(settleProjectObservabilityRefreshAtom, { projectPath, requestKey: staleRequest });

    expect(store.get(projectObservabilityResourceFamily(projectPath))).toMatchObject({
      value: current,
      pending: true,
      pendingRequestKey: currentRequest,
      stale: true,
    });

    store.set(settleProjectObservabilityRefreshAtom, { projectPath, requestKey: currentRequest });

    expect(store.get(projectObservabilityResourceFamily(projectPath))).toMatchObject({
      value: current,
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("settles only the pending project tasks request that owns the marker", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = tasks();
    const staleRequest = projectResourceRequestKey(
      { projectPath, endpointKey: "127.0.0.1:43190", generation: 1 },
      1,
    );
    const currentRequest = projectResourceRequestKey(
      { projectPath, endpointKey: "127.0.0.1:43191", generation: 2 },
      2,
    );

    store.set(applyProjectTasksSuccessAtom, {
      projectPath,
      tasks: current,
      updatedAt: 10,
    });
    store.set(beginProjectTasksRefreshAtom, { projectPath, requestKey: staleRequest });
    store.set(beginProjectTasksRefreshAtom, { projectPath, requestKey: currentRequest });
    store.set(settleProjectTasksRefreshAtom, { projectPath, requestKey: staleRequest });

    expect(store.get(projectTasksResourceFamily(projectPath))).toMatchObject({
      value: current,
      pending: true,
      pendingRequestKey: currentRequest,
      stale: true,
    });

    store.set(settleProjectTasksRefreshAtom, { projectPath, requestKey: currentRequest });

    expect(store.get(projectTasksResourceFamily(projectPath))).toMatchObject({
      value: current,
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });
});
