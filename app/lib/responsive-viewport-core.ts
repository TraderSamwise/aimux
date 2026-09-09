import { PERSISTENT_SIDEBAR_MIN_WIDTH, type SidebarPresentation } from "@/lib/app-shell-layout";
import { CHAT_SPLIT_VIEW_MIN_WIDTH } from "@/lib/chat-output-mode";

const TOP_BAR_COMPACT_WIDTH = 640;
const CHAT_HEADER_COMPACT_WIDTH = 430;
const DESKTOP_NATIVE_WIDTH = 900;
const DESKTOP_NATIVE_SHORT_EDGE = 700;
const VIEWPORT_WIDTH_STEP = 32;
const VIEWPORT_HEIGHT_STEP = 24;

export type ResponsiveViewport = {
  chatHeaderCompact: boolean;
  chatSplitWidth: number;
  isDesktopNative: boolean;
  layoutHeight: number;
  layoutWidth: number;
  sidebarPresentation: SidebarPresentation;
  topBarCompact: boolean;
};

function bucketDimension(value: number, step: number): number {
  return Math.max(0, Math.round(value / step) * step);
}

export function isDesktopNativeViewportSize(width: number, height: number): boolean {
  return width >= DESKTOP_NATIVE_WIDTH && Math.min(width, height) >= DESKTOP_NATIVE_SHORT_EDGE;
}

export function createResponsiveViewportValue({
  height,
  isDesktopNative,
  width,
}: {
  height: number;
  isDesktopNative: boolean;
  width: number;
}): ResponsiveViewport {
  const breakpointWidth = Math.max(0, width);
  const layoutWidth = bucketDimension(width, VIEWPORT_WIDTH_STEP);
  const layoutHeight = bucketDimension(height, VIEWPORT_HEIGHT_STEP);
  const sidebarPresentation: SidebarPresentation =
    breakpointWidth >= PERSISTENT_SIDEBAR_MIN_WIDTH ? "persistent" : "drawer";
  const chatSplitWidth =
    breakpointWidth >= CHAT_SPLIT_VIEW_MIN_WIDTH
      ? CHAT_SPLIT_VIEW_MIN_WIDTH
      : CHAT_SPLIT_VIEW_MIN_WIDTH - 1;

  return {
    chatHeaderCompact: breakpointWidth < CHAT_HEADER_COMPACT_WIDTH,
    chatSplitWidth,
    isDesktopNative,
    layoutHeight,
    layoutWidth,
    sidebarPresentation,
    topBarCompact: breakpointWidth < TOP_BAR_COMPACT_WIDTH,
  };
}
