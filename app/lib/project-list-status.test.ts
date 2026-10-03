import { describe, expect, it } from "vitest";

import {
  PROJECT_LIST_LOADING,
  PROJECT_LIST_OK,
  projectListEmptyMessage,
  projectListFailed,
  projectListPartial,
  projectListStaleMessage,
  projectListUnavailable,
  relayUnavailableDetail,
} from "./project-list-status";

describe("an empty list only reads as empty when the answer is trustworthy", () => {
  it("says nothing extra when the fetch succeeded", () => {
    expect(projectListEmptyMessage(PROJECT_LIST_OK)).toBeNull();
  });

  it("names the daemon when it cannot be reached", () => {
    const message = projectListEmptyMessage(projectListUnavailable("Relay is connecting."));
    expect(message?.title).toBe("Cannot reach the daemon");
    expect(message?.detail).toBe("Relay is connecting.");
  });

  it("carries the error through when the request failed", () => {
    const message = projectListEmptyMessage(projectListFailed("HTTP 502 from /projects"));
    expect(message?.title).toBe("Could not load projects");
    expect(message?.detail).toBe("HTTP 502 from /projects");
  });

  it("distinguishes not-yet-loaded from empty", () => {
    expect(projectListEmptyMessage(PROJECT_LIST_LOADING)?.title).toBe("Loading projects");
  });

  it("never returns an empty detail, however the failure was reported", () => {
    expect(projectListUnavailable("   ").detail).not.toBe("");
    expect(projectListFailed("").detail).not.toBe("");
  });
});

describe("a list that is on screen but not refreshing says so", () => {
  it("marks an unavailable daemon", () => {
    expect(projectListStaleMessage(projectListUnavailable("The daemon is offline."))).toBe(
      "Not refreshing: The daemon is offline.",
    );
  });

  it("marks a failed refresh", () => {
    expect(projectListStaleMessage(projectListFailed("socket hang up"))).toBe(
      "Not refreshing: socket hang up",
    );
  });

  it("stays quiet while the list is good", () => {
    expect(projectListStaleMessage(PROJECT_LIST_OK)).toBeNull();
    expect(projectListStaleMessage(PROJECT_LIST_LOADING)).toBeNull();
  });
});

describe("the daemon-unreachable detail is written for the person reading it", () => {
  it("tells a waiting device what to do", () => {
    expect(relayUnavailableDetail("device_pending")).toBe(
      "This device is waiting for approval on your Mac.",
    );
  });

  it("never leaks an internal status name for a state it knows", () => {
    for (const status of [
      "device_pending",
      "daemon_offline",
      "auth_failed",
      "relay_unavailable",
      "connecting",
      "disconnected",
      "client_storage_error",
    ]) {
      const detail = relayUnavailableDetail(status);
      expect(detail, status).not.toBe(`The relay is ${status}.`);
      expect(detail, `${status} leaked its identifier`).not.toMatch(/_/);
    }
  });

  it("still says something for a status it does not know", () => {
    expect(relayUnavailableDetail("wat")).toBe("The relay is wat.");
  });
});

describe("a project list missing one machine", () => {
  it("names the machines that did not answer", () => {
    const status = projectListPartial([
      { machineId: "strix", machineName: "sam-strix", error: "Machine strix is not connected" },
    ]);
    expect(status).toEqual({
      kind: "partial",
      detail: "sam-strix: Machine strix is not connected",
    });
  });

  it("falls back to the id when the machine has no name", () => {
    expect(
      projectListPartial([{ machineId: "abc123", machineName: "", error: "timed out" }]).detail,
    ).toBe("abc123: timed out");
  });

  // The list on screen is real, so nothing replaces it -- but it is short, and
  // saying so is the difference between a partial answer and a wrong one.
  it("shows the list and says it is short", () => {
    const status = projectListPartial([
      { machineId: "strix", machineName: "sam-strix", error: "timed out" },
    ]);
    expect(projectListEmptyMessage(status)).toBeNull();
    expect(projectListStaleMessage(status)).toBe(
      "Some machines did not answer: sam-strix: timed out",
    );
  });
});
