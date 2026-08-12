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

  it("formats terminal previews through the shared terminal display pipeline", () => {
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
                output: [
                  "\x1b[38;5;69mRun\x1b[0m yarn test",
                  "────────────────────────────────────────────────────────────────",
                  "──────────────────",
                  "plain",
                ].join("\n"),
              },
            },
          ]),
        ],
      },
    ]);

    expect(tile?.previewLines).toEqual([
      "Run yarn test",
      "────────────────────────────────────────────────",
      "plain",
    ]);
    expect(tile?.previewLines.join("\n")).not.toContain("[38;5");
    expect(tile?.previewLines.join("\n")).not.toContain("\x1b");
  });

  it("uses chat preview messages when chat previews are requested", () => {
    const [tile] = buildExposeTiles(
      [
        {
          project: tealstreet,
          groups: [
            group("Main Checkout", [
              {
                id: "a",
                status: "running",
                command: "codex",
                chatPreview: {
                  source: "readAgentOutput",
                  capturedAt: "2026-08-12T00:00:00.000Z",
                  messages: [
                    {
                      id: "old",
                      role: "assistant",
                      text: "old",
                      parts: [{ type: "text", text: "old" }],
                    },
                    {
                      id: "u1",
                      role: "user",
                      text: "again",
                      parts: [{ type: "text", text: "again" }],
                    },
                    {
                      id: "a1",
                      role: "assistant",
                      text: "done",
                      parts: [{ type: "text", text: "done" }],
                    },
                  ],
                },
              },
            ]),
          ],
        },
      ],
      { previewMode: "chat" },
    );

    expect(tile?.previewMode).toBe("chat");
    expect(tile?.chatPreviewMessages).toEqual([
      { id: "old", role: "assistant", text: "old" },
      { id: "u1", role: "user", text: "again" },
      { id: "a1", role: "assistant", text: "done" },
    ]);
  });

  it("falls back to terminal preview when chat preview is missing", () => {
    const [tile] = buildExposeTiles(
      [
        {
          project: tealstreet,
          groups: [group("Main Checkout", [{ id: "a", status: "running", command: "codex" }])],
        },
      ],
      { previewMode: "chat" },
    );

    expect(tile?.previewMode).toBe("terminal");
  });
});
