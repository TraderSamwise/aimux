import { describe, expect, it, vi } from "vitest";
import { FocusedRenderer, type FocusedRenderableSession } from "./focused-renderer.js";
import type { SessionTerminalViewport } from "./session-terminal-state.js";
import stripAnsi from "strip-ansi";

function makeViewport(lines: string[], cols = 20, rows = lines.length): SessionTerminalViewport {
  return {
    rows,
    cols,
    cursor: { row: Math.max(1, rows), col: 1 },
    visibleLines: Array.from({ length: rows }, (_, index) => ({
      cells: [{ chars: lines[index] ?? "", width: (lines[index] ?? "").length }],
      wrapped: false,
    })),
  };
}

function makeSession(id: string, viewport: SessionTerminalViewport): FocusedRenderableSession {
  return {
    id,
    getViewportFrame: () => viewport,
  };
}

describe("FocusedRenderer", () => {
  it("fully redraws the viewport on the first render", async () => {
    const writes: string[] = [];
    const renderFooter = vi.fn();
    const renderer = new FocusedRenderer({} as any, renderFooter, (data) => writes.push(data));

    await renderer.renderSession(makeSession("s1", makeViewport(["hello", "world"], 20, 2)), true);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("\x1b[1;1H\x1b[2K");
    expect(writes[0]).toContain("\x1b[2;1H\x1b[2K");
    expect(stripAnsi(writes[0])).toContain("hello");
    expect(stripAnsi(writes[0])).toContain("world");
    expect(renderFooter).toHaveBeenCalledWith({ row: 2, col: 1 }, true);
  });

  it("only redraws changed rows on incremental renders", async () => {
    const writes: string[] = [];
    const renderFooter = vi.fn();
    const renderer = new FocusedRenderer({} as any, renderFooter, (data) => writes.push(data));
    let viewport = makeViewport(["hello", "world"], 20, 2);
    const session = makeSession("s1", viewport);

    await renderer.renderSession(session, true);
    writes.length = 0;

    viewport = makeViewport(["hello", "changed"], 20, 2);
    await renderer.renderSession(makeSession("s1", viewport), false);

    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("\x1b[1;1H\x1b[2K");
    expect(writes[0]).toContain("\x1b[2;1H\x1b[2K");
    expect(stripAnsi(writes[0])).toContain("changed");
    expect(renderFooter).toHaveBeenLastCalledWith({ row: 2, col: 1 }, false);
  });

  it("forces a full redraw after invalidate", async () => {
    const writes: string[] = [];
    const renderFooter = vi.fn();
    const renderer = new FocusedRenderer({} as any, renderFooter, (data) => writes.push(data));
    const viewport = makeViewport(["one", "two"], 20, 2);

    await renderer.renderSession(makeSession("s1", viewport), true);
    writes.length = 0;

    renderer.invalidate();
    await renderer.renderSession(makeSession("s1", viewport), true);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("\x1b[1;1H\x1b[2K");
    expect(writes[0]).toContain("\x1b[2;1H\x1b[2K");
    expect(stripAnsi(writes[0])).toContain("one");
    expect(stripAnsi(writes[0])).toContain("two");
  });

  it("forces a full redraw when the viewport dimensions change", async () => {
    const writes: string[] = [];
    const renderFooter = vi.fn();
    const renderer = new FocusedRenderer({} as any, renderFooter, (data) => writes.push(data));

    await renderer.renderSession(makeSession("s1", makeViewport(["one", "two"], 20, 2)), true);
    writes.length = 0;

    await renderer.renderSession(makeSession("s1", makeViewport(["one", "two", "three"], 30, 3)), true);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("\x1b[1;1H\x1b[2K");
    expect(writes[0]).toContain("\x1b[2;1H\x1b[2K");
    expect(writes[0]).toContain("\x1b[3;1H\x1b[2K");
    expect(stripAnsi(writes[0])).toContain("one");
    expect(stripAnsi(writes[0])).toContain("two");
    expect(stripAnsi(writes[0])).toContain("three");
  });
});
