import { describe, expect, it } from "vitest";

import { TOP_CHROME_Z_INDEX, topChromeLayerStyle } from "./top-chrome-layer";

describe("top chrome layer", () => {
  it("claims the layer whether or not the chrome is overlaid", () => {
    // The bug: the non-overlaid branch was a bare `{ flexShrink: 0 }`. With no
    // z-index it tied with the content branch at 0, and the content is later in
    // DOM order, so it painted over an open account menu. Only the project
    // overview was affected because only a chat overlays its chrome.
    expect(topChromeLayerStyle(false).zIndex).toBe(TOP_CHROME_Z_INDEX);
    expect(topChromeLayerStyle(true).zIndex).toBe(TOP_CHROME_Z_INDEX);
  });

  it("keeps the two branches on one layer", () => {
    // Two literals drift. The point of the helper is that they cannot.
    expect(topChromeLayerStyle(true).zIndex).toBe(topChromeLayerStyle(false).zIndex);
  });

  it("only the overlaid branch is taken out of the flow", () => {
    expect(topChromeLayerStyle(true).position).toBe("absolute");
    expect(topChromeLayerStyle(false).position).toBeUndefined();
    expect(topChromeLayerStyle(false).flexShrink).toBe(0);
  });
});
