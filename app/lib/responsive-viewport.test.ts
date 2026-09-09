import { describe, expect, it } from "vitest";
import { createResponsiveViewportValue } from "@/lib/responsive-viewport-core";

describe("createResponsiveViewportValue", () => {
  it("keeps split and sidebar thresholds exact while bucketing layout width", () => {
    const below = createResponsiveViewportValue({
      height: 820,
      isDesktopNative: true,
      width: 899,
    });
    const at = createResponsiveViewportValue({
      height: 820,
      isDesktopNative: true,
      width: 900,
    });

    expect(below.chatSplitWidth).toBe(899);
    expect(below.sidebarPresentation).toBe("drawer");
    expect(at.chatSplitWidth).toBe(900);
    expect(at.sidebarPresentation).toBe("persistent");
    expect(at.layoutWidth).toBe(896);
  });

  it("only changes continuous layout width on coarse steps", () => {
    const first = createResponsiveViewportValue({
      height: 801,
      isDesktopNative: true,
      width: 1201,
    });
    const second = createResponsiveViewportValue({
      height: 803,
      isDesktopNative: true,
      width: 1210,
    });

    expect(first.layoutWidth).toBe(second.layoutWidth);
    expect(first.layoutHeight).toBe(second.layoutHeight);
  });
});
