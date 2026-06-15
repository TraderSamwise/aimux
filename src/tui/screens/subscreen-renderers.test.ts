import { describe, expect, it } from "vitest";
import { buildGraveyardViewModel } from "../../multiplexer/graveyard-view-model.js";
import { keycap, statusDot } from "../render/theme.js";
import { stripAnsi } from "../render/text.js";
import { renderGraveyardScreen } from "./subscreen-renderers.js";

function renderGraveyard(graveyardIndex = 0): string {
  const ago = (days: number): string => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const vm = buildGraveyardViewModel({
    worktrees: [
      {
        path: "/x/test6",
        name: "test6",
        branch: "test6",
        graveyardedAt: ago(8),
        agents: [{ id: "claude-ifc0xo", command: "claude", tool: "claude", backendSessionId: "c64917c2aa" }],
        services: [],
      },
    ] as never,
    agents: [{ id: "codex-mrh12h", command: "codex", tool: "codex", worktreePath: "/x/chat-parser" }] as never,
    lastUsedById: { "claude-ifc0xo": { lastUsedAt: ago(8) } } as never,
  });
  let out = "";
  const ctx = {
    getViewportSize: () => ({ cols: 120, rows: 40 }),
    graveyardViewModel: vm,
    graveyardIndex,
    dashboardState: { detailsSidebarVisible: true },
    centerInWidth: (s: string) => s,
    composeSplitScreen: (left: string[], _r: string[], _c: number, vh: number) => left.slice(0, vh),
    wrapKeyValue: (k: string, v: string) => [`${k ? `${k}: ` : ""}${v ?? ""}`],
    truncatePlain: (s: string, n: number) => (s ?? "").slice(0, n),
    basename: (p: string) => p.split("/").pop(),
    writeFrame: (f: string) => {
      out = f;
    },
  };
  renderGraveyardScreen(ctx as never);
  return out;
}

describe("renderGraveyardScreen", () => {
  it("renders graveyarded worktrees as design-language cards", () => {
    const frame = renderGraveyard();
    expect(frame).toContain("╭");
    expect(frame).toContain("╰");
    const plain = stripAnsi(frame);
    expect(plain).toContain("test6");
    expect(plain).toContain("claude:claude-ifc0xo");
  });

  it("renders resurrect numbers as keycaps on selectable rows", () => {
    const frame = renderGraveyard();
    // worktree action number 1 and standalone agent action number 2 both get keycaps.
    expect(frame).toContain(keycap("1"));
    expect(frame).toContain(keycap("2"));
  });

  it("renders dead agents with the muted offline status dot", () => {
    const frame = renderGraveyard();
    expect(frame).toContain(statusDot("offline"));
  });

  it("shows recency as a count chip in the card summary", () => {
    const plain = stripAnsi(renderGraveyard());
    expect(plain).toContain("1w ago");
  });
});
