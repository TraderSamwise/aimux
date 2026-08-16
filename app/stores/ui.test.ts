import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import { sidebarModeAtom } from "./ui";

describe("ui store", () => {
  it("defaults the project sidebar to the dashboard tab", () => {
    const store = createStore();

    expect(store.get(sidebarModeAtom)).toBe("dashboard");
  });
});
