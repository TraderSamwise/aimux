import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DRAWER_LAYER_Z_INDEX,
  TOP_CHROME_Z_INDEX,
  contentLayerStyle,
  topChromeLayerStyle,
} from "./top-chrome-layer";

const APP_SHELL = readFileSync(join(__dirname, "..", "components", "AppShell.tsx"), "utf8");

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
    const overlaid = topChromeLayerStyle(true);
    expect(overlaid.position).toBe("absolute");
    // Pinned to the top edge, or an absolute bar sits wherever it was laid out.
    expect([overlaid.top, overlaid.left, overlaid.right]).toEqual([0, 0, 0]);
    expect(topChromeLayerStyle(false).position).toBeUndefined();
    expect(topChromeLayerStyle(false).flexShrink).toBe(0);
  });
});

describe("an open drawer outranks the chrome", () => {
  // The drawer and its scrim are children of the content branch, and that
  // branch is a stacking context, so their 80/90 cannot reach past it. With
  // the chrome at 60 the scrim's top 56px went dead: drawer open, tap where
  // the top bar is, and the account menu opened instead of the drawer
  // dismissing -- leaving the drawer over whatever you navigated to next.
  it("lifts the branch holding the drawer above the chrome", () => {
    expect(DRAWER_LAYER_Z_INDEX).toBeGreaterThan(TOP_CHROME_Z_INDEX);
    expect(contentLayerStyle(true).zIndex).toBe(DRAWER_LAYER_Z_INDEX);
  });

  it("drops back the moment the drawer closes", () => {
    // Unconditional, and the content is above the chrome again -- which is
    // the z-index that painted the page body over the account menu.
    expect(contentLayerStyle(false).zIndex).toBeUndefined();
  });
});

describe("the shell is actually wired to these", () => {
  // The helpers above are pure, so every case passes while AppShell calls
  // them with the wrong argument or not at all. These read the call sites.
  const withoutComments = APP_SHELL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("lays the chrome out through the helper, not a literal", () => {
    expect(withoutComments).toMatch(/style=\{topChromeLayerStyle\(overlayTopChrome\)\}/);
    // The ternary this replaced. Reverting to it passes every pure test.
    expect(withoutComments).not.toMatch(/position: "absolute", right: 0, top: 0, zIndex: 60/);
  });

  it("gives the content branch the drawer layer on exactly the open-drawer case", () => {
    expect(withoutComments).toMatch(
      /style=\{contentLayerStyle\(usesDrawerSidebar && sidebarOpen\)\}/,
    );
  });
});
