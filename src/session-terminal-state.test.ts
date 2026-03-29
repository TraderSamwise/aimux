import { describe, expect, it } from "vitest";
import { SessionTerminalState } from "./session-terminal-state.js";

async function settleTerminal(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("SessionTerminalState", () => {
  it("exports and hydrates a structured terminal snapshot", async () => {
    const state = new SessionTerminalState(20, 4);
    state.write("alpha\r\nbeta\r\ngamma");
    await settleTerminal();

    const snapshot = state.exportSnapshot();

    expect(snapshot.cols).toBe(20);
    expect(snapshot.rows).toBe(4);
    expect(snapshot.lines.length).toBeGreaterThan(0);

    const restored = new SessionTerminalState(1, 1);
    await restored.hydrateSnapshot(snapshot);

    expect(restored.getScreenState()).toBe(state.getScreenState());
    expect(restored.getCursorPosition()).toEqual(state.getCursorPosition());
  });

  it("bounds snapshot size while keeping recent buffer lines", async () => {
    const state = new SessionTerminalState(20, 4);
    for (let i = 0; i < 30; i++) {
      state.write(`line-${i}\r\n`);
    }
    await settleTerminal();

    const snapshot = state.exportSnapshot(5);

    expect(snapshot.lines.length).toBeLessThanOrEqual(5);
    expect(snapshot.lines.length).toBeGreaterThan(0);
    expect(
      snapshot.lines.some((line) =>
        line.cells
          .map((cell) => cell.chars || " ")
          .join("")
          .includes("line-29"),
      ),
    ).toBe(true);
  });

  it("restores the saved viewport when hydrating a bounded snapshot", async () => {
    const state = new SessionTerminalState(20, 4);
    for (let i = 0; i < 20; i++) {
      state.write(`line-${i}\r\n`);
    }
    await settleTerminal();

    state.scrollLines(-3);
    const before = state.getScreenState();
    const snapshot = state.exportSnapshot(8);

    const restored = new SessionTerminalState(20, 4);
    await restored.hydrateSnapshot(snapshot);

    expect(restored.getScreenState()).toBe(before);
  });

  it("preserves wrapped lines across snapshot hydration", async () => {
    const state = new SessionTerminalState(10, 4);
    state.write("1234567890abcdefghij\r\n");
    await settleTerminal();

    const before = state.getScreenState();
    const snapshot = state.exportSnapshot();

    expect(snapshot.lines.some((line) => line.wrapped)).toBe(true);

    const restored = new SessionTerminalState(10, 4);
    await restored.hydrateSnapshot(snapshot);

    expect(restored.getScreenState()).toBe(before);
  });
});
