import { describe, expect, it } from "vitest";
import type { DaemonProject } from "@/lib/api";
import {
  buildExposeTiles,
  filterExposeTiles,
  groupExposeTiles,
  summarizeExposeTiles,
  type ExposeSourceItem,
} from "./expose-model";

function previewText(lines: readonly (readonly { text: string }[])[]): string[] {
  return lines.map((line) => line.map((span) => span.text).join(""));
}

const project: DaemonProject = {
  id: "teal",
  name: "tealstreet-next",
  path: "/repo/tealstreet-next",
  dashboardSessionName: "teal",
  service: null,
  serviceAlive: true,
  serviceEndpoint: null,
};

function item(id: string, worktree: string, tone: number, kind = "working"): ExposeSourceItem {
  return {
    id,
    label: `codex-${id}`,
    target: { windowId: `@${id}`, windowIndex: Number(id) },
    metadata: {
      sessionId: `session-${id}`,
      command: "codex --model gpt-5.5",
      toolConfigKey: "codex",
      worktreePath: `/repo/${worktree}`,
    },
    exposeContext: { worktree, tone },
    exposeStatus: { kind, label: kind === "needs" ? "Needs input" : "Working" },
  };
}

describe("expose model", () => {
  it("preserves the API item order and renders server Exposé context", () => {
    const tiles = buildExposeTiles([
      {
        project,
        items: [item("1", "main", 0), item("2", "custom-modules", 1), item("3", "e2e-audit", 2)],
      },
    ]);

    expect(tiles.map((tile) => `${tile.worktreeName}:${tile.sessionId}`)).toEqual([
      "main:session-1",
      "custom-modules:session-2",
      "e2e-audit:session-3",
    ]);
    expect(tiles.map((tile) => tile.semanticTitle)).toEqual([
      "main",
      "custom-modules",
      "e2e-audit",
    ]);
    expect(tiles.map((tile) => tile.tone)).toEqual(["#00afd7", "#5faf5f", "#d7af5f"]);
  });

  it("groups tiles by the server semantic title without reshuffling", () => {
    const sections = groupExposeTiles(
      buildExposeTiles([
        {
          project,
          items: [item("1", "main", 0), item("2", "main", 0), item("3", "custom-modules", 1)],
        },
      ]),
    );

    expect(sections.map((section) => section.label)).toEqual(["main", "custom-modules"]);
    expect(sections[0]?.tiles.map((tile) => tile.sessionId)).toEqual(["session-1", "session-2"]);
  });

  it("uses the TUI status chip fields for filtering and summary", () => {
    const tiles = buildExposeTiles([
      {
        project,
        items: [
          item("1", "main", 0, "working"),
          item("2", "main", 0, "needs"),
          item("3", "main", 0, "done"),
        ],
      },
    ]);

    expect(filterExposeTiles(tiles, "working").map((tile) => tile.sessionId)).toEqual([
      "session-1",
    ]);
    expect(filterExposeTiles(tiles, "attention").map((tile) => tile.sessionId)).toEqual([
      "session-2",
    ]);
    expect(filterExposeTiles(tiles, "ready").map((tile) => tile.sessionId)).toEqual(["session-3"]);
    expect(summarizeExposeTiles(tiles)).toEqual({
      total: 3,
      working: 1,
      attention: 1,
      ready: 1,
    });
  });

  it("does not invent a status when the TUI source omits a chip", () => {
    const [tile] = buildExposeTiles([
      {
        project,
        items: [{ ...item("1", "main", 0), exposeStatus: undefined }],
      },
    ]);

    expect(tile?.status).toBeNull();
    expect(tile?.statusKind).toBeNull();
    expect(filterExposeTiles(tile ? [tile] : [], "ready")).toEqual([]);
    expect(summarizeExposeTiles(tile ? [tile] : [])).toEqual({
      total: 1,
      working: 0,
      attention: 0,
      ready: 0,
    });
  });

  it("formats terminal previews through the shared terminal display pipeline", () => {
    const [tile] = buildExposeTiles([
      {
        project,
        items: [
          {
            ...item("1", "main", 0),
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
        ],
      },
    ]);

    expect(previewText(tile?.previewLines ?? [])).toEqual([
      "Run yarn test",
      "────────────────────────────────────────────────",
      "plain",
    ]);
    expect(tile?.previewLines[0]?.[0]?.style.color).toBe("#5f87ff");
    expect(previewText(tile?.previewLines ?? []).join("\n")).not.toContain("[38;5");
    expect(previewText(tile?.previewLines ?? []).join("\n")).not.toContain("\x1b");
  });
});
