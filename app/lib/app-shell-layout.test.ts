import { describe, expect, it } from "vitest";

import {
  canUsePersistentSidebar,
  getSidebarPresentation,
  PERSISTENT_SIDEBAR_MIN_WIDTH,
  shouldDismissSidebarOnNavigate,
} from "./app-shell-layout";

describe("app shell layout", () => {
  it("keeps phone-sized native viewports on the drawer sidebar", () => {
    expect(getSidebarPresentation(430)).toBe("drawer");
    expect(canUsePersistentSidebar(430)).toBe(false);
    expect(shouldDismissSidebarOnNavigate(430)).toBe(true);
  });

  it("uses the persistent inline sidebar on wide viewports regardless of platform", () => {
    expect(canUsePersistentSidebar(PERSISTENT_SIDEBAR_MIN_WIDTH - 1)).toBe(false);
    expect(getSidebarPresentation(PERSISTENT_SIDEBAR_MIN_WIDTH)).toBe("persistent");
    expect(canUsePersistentSidebar(PERSISTENT_SIDEBAR_MIN_WIDTH)).toBe(true);
    expect(shouldDismissSidebarOnNavigate(PERSISTENT_SIDEBAR_MIN_WIDTH)).toBe(false);
    expect(canUsePersistentSidebar(1440)).toBe(true);
  });
});
