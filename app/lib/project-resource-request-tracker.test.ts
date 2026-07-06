import { describe, expect, it } from "vitest";
import { createProjectResourceRequestTracker } from "./project-resource-request-tracker";

describe("createProjectResourceRequestTracker", () => {
  it("rejects responses from a previous project or endpoint generation", () => {
    const tracker = createProjectResourceRequestTracker({
      projectPath: "/repo-a",
      endpointKey: "127.0.0.1:43190",
    });
    const oldRequest = tracker.begin();

    tracker.update({
      projectPath: "/repo-b",
      endpointKey: "127.0.0.1:43191",
    });
    const currentRequest = tracker.begin();

    expect(tracker.isCurrent(oldRequest)).toBe(false);
    expect(tracker.isCurrent(currentRequest)).toBe(true);
  });

  it("invalidates an in-flight refresh when a mutation changes the cached resource", () => {
    const tracker = createProjectResourceRequestTracker({
      projectPath: "/repo",
      endpointKey: "127.0.0.1:43190",
    });
    const listBeforeMutation = tracker.begin();

    tracker.invalidate();
    const listAfterMutation = tracker.begin();

    expect(tracker.isCurrent(listBeforeMutation)).toBe(false);
    expect(tracker.isCurrent(listAfterMutation)).toBe(true);
  });

  it("invalidates in-flight work on unmount without changing project identity", () => {
    const tracker = createProjectResourceRequestTracker({
      projectPath: "/repo",
      endpointKey: "127.0.0.1:43190",
    });
    const inFlight = tracker.begin();

    tracker.invalidateGeneration();

    expect(tracker.isCurrent(inFlight)).toBe(false);
  });
});
