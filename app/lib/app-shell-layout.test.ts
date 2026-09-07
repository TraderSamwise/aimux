import { describe, expect, it } from "vitest";

import { canUsePersistentSidebar, PERSISTENT_SIDEBAR_MIN_WIDTH } from "./app-shell-layout";

describe("app shell layout", () => {
  it("keeps phone-sized native viewports on the drawer sidebar", () => {
    expect(canUsePersistentSidebar(430)).toBe(false);
  });

  it("uses the persistent inline sidebar on wide viewports regardless of platform", () => {
    expect(canUsePersistentSidebar(PERSISTENT_SIDEBAR_MIN_WIDTH - 1)).toBe(false);
    expect(canUsePersistentSidebar(PERSISTENT_SIDEBAR_MIN_WIDTH)).toBe(true);
    expect(canUsePersistentSidebar(1440)).toBe(true);
  });
});
