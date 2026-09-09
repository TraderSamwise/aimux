import { describe, expect, it } from "vitest";
import {
  createResponsiveViewportValue,
  isDesktopNativeViewportSize,
} from "@/lib/responsive-viewport-core";

describe("createResponsiveViewportValue", () => {
  it("keeps split and sidebar thresholds exact while bucketing layout width", () => {
    const below = createResponsiveViewportValue({
      height: 820,
      isDesktopNative: true,
      width: 899.5,
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

  it("keeps compact breakpoints exact at fractional edges", () => {
    const chatHeaderBelow = createResponsiveViewportValue({
      height: 820,
      isDesktopNative: true,
      width: 429.5,
    });
    const chatHeaderAt = createResponsiveViewportValue({
      height: 820,
      isDesktopNative: true,
      width: 430,
    });
    const topBarBelow = createResponsiveViewportValue({
      height: 820,
      isDesktopNative: true,
      width: 639.5,
    });
    const topBarAt = createResponsiveViewportValue({
      height: 820,
      isDesktopNative: true,
      width: 640,
    });

    expect(chatHeaderBelow.chatHeaderCompact).toBe(true);
    expect(chatHeaderAt.chatHeaderCompact).toBe(false);
    expect(topBarBelow.topBarCompact).toBe(true);
    expect(topBarAt.topBarCompact).toBe(false);
  });

  it("keeps native desktop size thresholds exact at fractional edges", () => {
    expect(isDesktopNativeViewportSize(899.5, 720)).toBe(false);
    expect(isDesktopNativeViewportSize(900, 699.5)).toBe(false);
    expect(isDesktopNativeViewportSize(900, 700)).toBe(true);
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
