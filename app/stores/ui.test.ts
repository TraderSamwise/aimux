import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import { chatFocusModeAtom, sidebarModeAtom } from "./ui";

describe("ui store", () => {
  it("defaults the project sidebar to the dashboard tab", () => {
    const store = createStore();

    expect(store.get(sidebarModeAtom)).toBe("dashboard");
  });

  it("starts chat focus mode off", () => {
    const store = createStore();

    expect(store.get(chatFocusModeAtom)).toBe(false);
  });
});
