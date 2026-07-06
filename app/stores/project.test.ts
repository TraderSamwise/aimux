import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type {
  GraveyardEntryResponse,
  TaskSummaryResponse,
  ThreadSummaryResponse,
  WorktreeGraveyardEntryResponse,
} from "@/lib/api";
import {
  applyProjectGraveyardActionFailureAtom,
  applyProjectGraveyardFailureAtom,
  applyProjectGraveyardSuccessAtom,
  applyProjectObservabilityFailureAtom,
  applyProjectObservabilitySuccessAtom,
  applyProjectTasksFailureAtom,
  applyProjectTasksSuccessAtom,
  applyProjectThreadsFailureAtom,
  applyProjectThreadsSuccessAtom,
  beginProjectGraveyardRefreshAtom,
  beginProjectObservabilityRefreshAtom,
  beginProjectTasksRefreshAtom,
  beginProjectThreadsRefreshAtom,
  clearProjectGraveyardResourceAtom,
  clearProjectObservabilityResourceAtom,
  clearProjectTasksResourceAtom,
  clearProjectThreadsResourceAtom,
  emptyProjectObservability,
  isCurrentProjectResourceRequest,
  projectObservabilityFamily,
  projectObservabilityResourceFamily,
  projectGraveyardFamily,
  projectGraveyardResourceFamily,
  projectResourceRequestKey,
  projectTasksFamily,
  projectTasksResourceFamily,
  projectThreadsFamily,
  projectThreadsResourceFamily,
  removeProjectGraveyardAgentAtom,
  removeProjectGraveyardWorktreeAtom,
  settleProjectGraveyardRefreshAtom,
  settleProjectObservabilityRefreshAtom,
  settleProjectTasksRefreshAtom,
  settleProjectThreadsRefreshAtom,
  type ProjectGraveyardValue,
  type ProjectObservabilityValue,
  type ProjectTasksValue,
  type ProjectThreadsValue,
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

function thread(id: string): ThreadSummaryResponse {
  return {
    thread: {
      id,
      kind: "conversation",
      title: "Thread",
      status: "open",
    },
    latestMessage: {
      body: "Latest",
      ts: "2026-01-01T00:00:00.000Z",
    },
    unreadCount: 1,
  };
}

function threads(overrides: Partial<ProjectThreadsValue> = {}): ProjectThreadsValue {
  return {
    threads: [thread("thread-1")],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function graveyardEntry(id: string): GraveyardEntryResponse {
  return {
    id,
    tool: "claude",
    label: "Claude",
    diedAt: "2026-01-01T00:00:00.000Z",
  };
}

function graveyardWorktree(path: string): WorktreeGraveyardEntryResponse {
  return {
    name: "feature",
    path,
    branch: "feature",
    graveyardedAt: "2026-01-01T00:00:00.000Z",
  };
}

function graveyard(overrides: Partial<ProjectGraveyardValue> = {}): ProjectGraveyardValue {
  return {
    entries: [graveyardEntry("dead-1")],
    worktrees: [graveyardWorktree("/repo/.aimux/worktrees/feature")],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type TestStore = ReturnType<typeof createStore>;

function putObservability(
  store: TestStore,
  projectPath: string,
  value: ProjectObservabilityValue,
  requestKey = "seed-observability",
  updatedAt = 10,
) {
  store.set(beginProjectObservabilityRefreshAtom, { projectPath, requestKey });
  store.set(applyProjectObservabilitySuccessAtom, {
    projectPath,
    requestKey,
    observability: value,
    updatedAt,
  });
}

function putTasks(
  store: TestStore,
  projectPath: string,
  value: ProjectTasksValue,
  requestKey = "seed-tasks",
  updatedAt = 10,
) {
  store.set(beginProjectTasksRefreshAtom, { projectPath, requestKey });
  store.set(applyProjectTasksSuccessAtom, {
    projectPath,
    requestKey,
    tasks: value,
    updatedAt,
  });
}

function putThreads(
  store: TestStore,
  projectPath: string,
  value: ProjectThreadsValue,
  requestKey = "seed-threads",
  updatedAt = 10,
) {
  store.set(beginProjectThreadsRefreshAtom, { projectPath, requestKey });
  store.set(applyProjectThreadsSuccessAtom, {
    projectPath,
    requestKey,
    threads: value,
    updatedAt,
  });
}

function putGraveyard(
  store: TestStore,
  projectPath: string,
  value: ProjectGraveyardValue,
  requestKey = "seed-graveyard",
  updatedAt = 10,
) {
  store.set(beginProjectGraveyardRefreshAtom, { projectPath, requestKey });
  store.set(applyProjectGraveyardSuccessAtom, {
    projectPath,
    requestKey,
    graveyard: value,
    updatedAt,
  });
}

describe("project resource lifecycle", () => {
  it("keeps stale project observability after a refresh failure", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = observability();
    const requestKey = "request-1";

    putObservability(store, projectPath, current);
    store.set(beginProjectObservabilityRefreshAtom, { projectPath, requestKey });
    store.set(applyProjectObservabilityFailureAtom, {
      projectPath,
      requestKey,
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
    const requestKey = "request-1";

    putTasks(store, projectPath, current);
    store.set(beginProjectTasksRefreshAtom, { projectPath, requestKey });
    store.set(applyProjectTasksFailureAtom, {
      projectPath,
      requestKey,
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

  it("keeps stale project threads after a refresh failure", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = threads();
    const requestKey = "request-1";

    putThreads(store, projectPath, current);
    store.set(beginProjectThreadsRefreshAtom, { projectPath, requestKey });
    store.set(applyProjectThreadsFailureAtom, {
      projectPath,
      requestKey,
      error: "service unavailable",
    });

    expect(store.get(projectThreadsFamily(projectPath))).toBe(current);
    expect(store.get(projectThreadsResourceFamily(projectPath))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("keeps stale project graveyard after a refresh failure", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = graveyard();
    const requestKey = "request-1";

    putGraveyard(store, projectPath, current);
    store.set(beginProjectGraveyardRefreshAtom, { projectPath, requestKey });
    store.set(applyProjectGraveyardFailureAtom, {
      projectPath,
      requestKey,
      error: "service unavailable",
    });

    expect(store.get(projectGraveyardFamily(projectPath))).toBe(current);
    expect(store.get(projectGraveyardResourceFamily(projectPath))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("clears stale/error metadata after project resources recover", () => {
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
    const recoveredThreads = threads({ threads: [thread("thread-2")] });
    const recoveredGraveyard = graveyard({ entries: [graveyardEntry("dead-2")] });
    const observabilityKey = "observability-recover";
    const tasksKey = "tasks-recover";
    const threadsKey = "threads-recover";
    const graveyardKey = "graveyard-recover";

    putObservability(store, projectPath, observability(), "observability-seed");
    putTasks(store, projectPath, tasks(), "tasks-seed");
    putThreads(store, projectPath, threads(), "threads-seed");
    putGraveyard(store, projectPath, graveyard(), "graveyard-seed");
    store.set(beginProjectObservabilityRefreshAtom, { projectPath, requestKey: observabilityKey });
    store.set(beginProjectTasksRefreshAtom, { projectPath, requestKey: tasksKey });
    store.set(beginProjectThreadsRefreshAtom, { projectPath, requestKey: threadsKey });
    store.set(beginProjectGraveyardRefreshAtom, { projectPath, requestKey: graveyardKey });
    store.set(applyProjectObservabilitySuccessAtom, {
      projectPath,
      requestKey: observabilityKey,
      observability: recoveredObservability,
      updatedAt: 20,
    });
    store.set(applyProjectTasksSuccessAtom, {
      projectPath,
      requestKey: tasksKey,
      tasks: recoveredTasks,
      updatedAt: 20,
    });
    store.set(applyProjectThreadsSuccessAtom, {
      projectPath,
      requestKey: threadsKey,
      threads: recoveredThreads,
      updatedAt: 20,
    });
    store.set(applyProjectGraveyardSuccessAtom, {
      projectPath,
      requestKey: graveyardKey,
      graveyard: recoveredGraveyard,
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
    expect(store.get(projectThreadsResourceFamily(projectPath))).toEqual({
      value: recoveredThreads,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: 20,
    });
    expect(store.get(projectGraveyardResourceFamily(projectPath))).toEqual({
      value: recoveredGraveyard,
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

    putObservability(store, projectPath, observability());
    putTasks(store, projectPath, tasks());
    putThreads(store, projectPath, threads());
    putGraveyard(store, projectPath, graveyard());
    store.set(clearProjectObservabilityResourceAtom, projectPath);
    store.set(clearProjectTasksResourceAtom, projectPath);
    store.set(clearProjectThreadsResourceAtom, projectPath);
    store.set(clearProjectGraveyardResourceAtom, projectPath);

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
    expect(store.get(projectThreadsResourceFamily(projectPath))).toEqual({
      value: null,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: null,
    });
    expect(store.get(projectGraveyardResourceFamily(projectPath))).toEqual({
      value: null,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: null,
    });
  });

  it("removes graveyard agent and worktree entries after successful mutations", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = graveyard({
      entries: [graveyardEntry("dead-1"), graveyardEntry("dead-2")],
      worktrees: [
        graveyardWorktree("/repo/.aimux/worktrees/feature-a"),
        graveyardWorktree("/repo/.aimux/worktrees/feature-b"),
      ],
    });

    putGraveyard(store, projectPath, current);
    store.set(removeProjectGraveyardAgentAtom, { projectPath, id: "dead-1" });
    store.set(removeProjectGraveyardWorktreeAtom, {
      projectPath,
      path: "/repo/.aimux/worktrees/feature-a",
    });

    expect(store.get(projectGraveyardResourceFamily(projectPath)).value).toMatchObject({
      entries: [{ id: "dead-2" }],
      worktrees: [{ path: "/repo/.aimux/worktrees/feature-b" }],
    });
    expect(store.get(projectGraveyardResourceFamily(projectPath)).error).toBeNull();
  });

  it("records graveyard action errors without stealing refresh ownership", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = graveyard();
    const requestKey = "refresh-in-flight";

    putGraveyard(store, projectPath, current);
    store.set(beginProjectGraveyardRefreshAtom, { projectPath, requestKey });
    store.set(applyProjectGraveyardActionFailureAtom, {
      projectPath,
      error: "resurrect failed",
    });

    expect(store.get(projectGraveyardResourceFamily(projectPath))).toMatchObject({
      value: current,
      error: "resurrect failed",
      pending: true,
      pendingRequestKey: requestKey,
      stale: true,
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

  it("creates unique project resource request keys across component remounts", () => {
    const scope = { projectPath: "/repo", endpointKey: "127.0.0.1:43190", generation: 1 };

    expect(projectResourceRequestKey(scope)).not.toBe(projectResourceRequestKey(scope));
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

    putObservability(store, projectPath, current);
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

    putTasks(store, projectPath, current);
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

  it("settles only the pending project threads request that owns the marker", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = threads();
    const staleRequest = projectResourceRequestKey(
      { projectPath, endpointKey: "127.0.0.1:43190", generation: 1 },
      1,
    );
    const currentRequest = projectResourceRequestKey(
      { projectPath, endpointKey: "127.0.0.1:43191", generation: 2 },
      2,
    );

    putThreads(store, projectPath, current);
    store.set(beginProjectThreadsRefreshAtom, { projectPath, requestKey: staleRequest });
    store.set(beginProjectThreadsRefreshAtom, { projectPath, requestKey: currentRequest });
    store.set(settleProjectThreadsRefreshAtom, { projectPath, requestKey: staleRequest });

    expect(store.get(projectThreadsResourceFamily(projectPath))).toMatchObject({
      value: current,
      pending: true,
      pendingRequestKey: currentRequest,
      stale: true,
    });

    store.set(settleProjectThreadsRefreshAtom, { projectPath, requestKey: currentRequest });

    expect(store.get(projectThreadsResourceFamily(projectPath))).toMatchObject({
      value: current,
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("settles only the pending project graveyard request that owns the marker", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = graveyard();
    const staleRequest = projectResourceRequestKey(
      { projectPath, endpointKey: "127.0.0.1:43190", generation: 1 },
      1,
    );
    const currentRequest = projectResourceRequestKey(
      { projectPath, endpointKey: "127.0.0.1:43191", generation: 2 },
      2,
    );

    putGraveyard(store, projectPath, current);
    store.set(beginProjectGraveyardRefreshAtom, { projectPath, requestKey: staleRequest });
    store.set(beginProjectGraveyardRefreshAtom, { projectPath, requestKey: currentRequest });
    store.set(settleProjectGraveyardRefreshAtom, { projectPath, requestKey: staleRequest });

    expect(store.get(projectGraveyardResourceFamily(projectPath))).toMatchObject({
      value: current,
      pending: true,
      pendingRequestKey: currentRequest,
      stale: true,
    });

    store.set(settleProjectGraveyardRefreshAtom, { projectPath, requestKey: currentRequest });

    expect(store.get(projectGraveyardResourceFamily(projectPath))).toMatchObject({
      value: current,
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("ignores stale project resource success and failure requests", () => {
    const store = createStore();
    const projectPath = "/repo";
    const currentObservabilityRequest = "observability-current";
    const currentTasksRequest = "tasks-current";
    const currentThreadsRequest = "threads-current";
    const currentGraveyardRequest = "graveyard-current";

    store.set(beginProjectObservabilityRefreshAtom, {
      projectPath,
      requestKey: currentObservabilityRequest,
    });
    store.set(applyProjectObservabilitySuccessAtom, {
      projectPath,
      requestKey: "observability-stale",
      observability: observability(),
      updatedAt: 10,
    });
    store.set(beginProjectTasksRefreshAtom, { projectPath, requestKey: currentTasksRequest });
    store.set(applyProjectTasksFailureAtom, {
      projectPath,
      requestKey: "tasks-stale",
      error: "old failure",
    });
    store.set(beginProjectThreadsRefreshAtom, { projectPath, requestKey: currentThreadsRequest });
    store.set(applyProjectThreadsSuccessAtom, {
      projectPath,
      requestKey: "threads-stale",
      threads: threads(),
      updatedAt: 10,
    });
    store.set(beginProjectGraveyardRefreshAtom, {
      projectPath,
      requestKey: currentGraveyardRequest,
    });
    store.set(applyProjectGraveyardFailureAtom, {
      projectPath,
      requestKey: "graveyard-stale",
      error: "old failure",
    });

    expect(store.get(projectObservabilityResourceFamily(projectPath))).toMatchObject({
      value: null,
      error: null,
      pending: true,
      pendingRequestKey: currentObservabilityRequest,
    });
    expect(store.get(projectTasksResourceFamily(projectPath))).toMatchObject({
      value: null,
      error: null,
      pending: true,
      pendingRequestKey: currentTasksRequest,
    });
    expect(store.get(projectThreadsResourceFamily(projectPath))).toMatchObject({
      value: null,
      error: null,
      pending: true,
      pendingRequestKey: currentThreadsRequest,
    });
    expect(store.get(projectGraveyardResourceFamily(projectPath))).toMatchObject({
      value: null,
      error: null,
      pending: true,
      pendingRequestKey: currentGraveyardRequest,
    });
  });
});
