import { describe, expect, it } from "vitest";
import type { DaemonProject } from "@/lib/api";
import type { WorktreeBucket } from "@/lib/desktop-state";
import { buildExposeTiles, filterExposeTiles, summarizeExposeTiles } from "./expose-model";

const tealstreet: DaemonProject = {
  id: "teal",
  name: "tealstreet-next",
  path: "/repo/tealstreet-next",
  dashboardSessionName: "teal",
  service: null,
  serviceAlive: true,
  serviceEndpoint: null,
};

const aimux: DaemonProject = {
  id: "aimux",
  name: "aimux",
  path: "/repo/aimux",
  dashboardSessionName: "aimux",
  service: null,
  serviceAlive: true,
  serviceEndpoint: null,
};

function group(name: string, sessions: WorktreeBucket["sessions"]): WorktreeBucket {
  return {
    key: name,
    name,
    branch: name === "Main Checkout" ? "master" : `feat/${name}`,
    path: name === "Main Checkout" ? "/repo/main" : `/repo/${name}`,
    isMainCheckout: name === "Main Checkout",
    sessions,
    services: [],
  };
}

describe("expose model", () => {
  it("keeps project, worktree, and session order from dashboard state", () => {
    const tiles = buildExposeTiles([
      {
        project: tealstreet,
        groups: [
          group("Main Checkout", [{ id: "a", status: "running", command: "codex" }]),
          group("custom-modules", [
            { id: "b", status: "idle", command: "codex" },
            { id: "c", status: "offline", command: "claude" },
          ]),
        ],
      },
      {
        project: aimux,
        groups: [group("Main Checkout", [{ id: "d", status: "running", command: "codex" }])],
      },
    ]);

    expect(
      tiles.map((tile) => `${tile.projectName}:${tile.worktreeName}:${tile.sessionId}`),
    ).toEqual([
      "tealstreet-next:Main Checkout:a",
      "tealstreet-next:custom-modules:b",
      "tealstreet-next:custom-modules:c",
      "aimux:Main Checkout:d",
    ]);
  });

  it("filters without reshuffling the remaining tiles", () => {
    const tiles = buildExposeTiles([
      {
        project: tealstreet,
        groups: [
          group("Main Checkout", [
            { id: "a", status: "running", command: "codex" },
            { id: "b", status: "idle", command: "codex" },
            { id: "c", status: "offline", command: "claude", attention: "needs_input" },
          ]),
        ],
      },
    ]);

    expect(filterExposeTiles(tiles, "working").map((tile) => tile.sessionId)).toEqual(["a"]);
    expect(filterExposeTiles(tiles, "attention").map((tile) => tile.sessionId)).toEqual(["c"]);
    expect(summarizeExposeTiles(tiles)).toEqual({
      total: 3,
      working: 1,
      attention: 1,
      ready: 1,
      offline: 0,
    });
  });

  it("uses bounded trailing nonblank preview lines", () => {
    const [tile] = buildExposeTiles([
      {
        project: tealstreet,
        groups: [
          group("Main Checkout", [
            {
              id: "a",
              status: "running",
              command: "codex",
              previewSnapshot: {
                source: "capture",
                capturedAt: "2026-08-12T00:00:00.000Z",
                output: ["", "one", "two", "three", "four", "five", "six", "seven", "eight"].join(
                  "\n",
                ),
              },
            },
          ]),
        ],
      },
    ]);

    expect(tile?.previewLines).toEqual(["two", "three", "four", "five", "six", "seven", "eight"]);
  });
});
