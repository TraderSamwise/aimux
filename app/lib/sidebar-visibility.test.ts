import { describe, expect, it } from "vitest";

import { sidebarOpenForPresentation } from "./sidebar-visibility";

describe("sidebar visibility across a resize", () => {
  it("comes back when the window is wide enough again", () => {
    // The bug: the shell ran `if (!persistent) setSidebarOpen(false)` and had
    // no branch for the other direction, so narrowing hid the sidebar and
    // widening never restored it. The window could only ever lose it.
    expect(sidebarOpenForPresentation({ persistent: false, forcedHidden: false })).toBe(false);
    expect(sidebarOpenForPresentation({ persistent: true, forcedHidden: false })).toBe(true);
  });

  it("stays hidden when the reader hid it deliberately", () => {
    // The other half, and the reason restoring needs somewhere to look:
    // without it, hiding the sidebar and resizing would bring it straight
    // back and the button would read as broken.
    expect(sidebarOpenForPresentation({ persistent: true, forcedHidden: true })).toBe(false);
  });

  it("keeps a narrow window closed whatever was asked for", () => {
    // There is no room for it either way, and the drawer is how a narrow
    // window gets the sidebar back.
    expect(sidebarOpenForPresentation({ persistent: false, forcedHidden: true })).toBe(false);
  });
});
