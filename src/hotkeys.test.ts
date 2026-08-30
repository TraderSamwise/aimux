import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HotkeyHandler, type HotkeyAction } from "./hotkeys.js";

describe("HotkeyHandler", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps leader shift-p to the work outline action", () => {
    const actions: HotkeyAction[] = [];
    const hotkeys = new HotkeyHandler((action) => actions.push(action));

    expect(hotkeys.feed(Buffer.from("\x01"))).toBeNull();
    expect(hotkeys.feed(Buffer.from("P"))).toBeNull();
    hotkeys.destroy();

    expect(actions).toEqual([{ type: "work-outline" }]);
  });

  it("keeps leader lowercase-p mapped to previous session", () => {
    const actions: HotkeyAction[] = [];
    const hotkeys = new HotkeyHandler((action) => actions.push(action));

    expect(hotkeys.feed(Buffer.from("\x01"))).toBeNull();
    expect(hotkeys.feed(Buffer.from("p"))).toBeNull();
    hotkeys.destroy();

    expect(actions).toEqual([{ type: "prev" }]);
  });
});
