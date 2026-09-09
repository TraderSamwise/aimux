import { PERSISTENT_SIDEBAR_MIN_WIDTH, type SidebarPresentation } from "@/lib/app-shell-layout";
import { CHAT_SPLIT_VIEW_MIN_WIDTH } from "@/lib/chat-output-mode";

const TOP_BAR_COMPACT_WIDTH = 640;
const CHAT_HEADER_COMPACT_WIDTH = 430;
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

export function createResponsiveViewportValue({
  height,
  isDesktopNative,
  width,
}: {
  height: number;
  isDesktopNative: boolean;
  width: number;
}): ResponsiveViewport {
  const roundedWidth = Math.max(0, Math.round(width));
  const layoutWidth = bucketDimension(width, VIEWPORT_WIDTH_STEP);
  const layoutHeight = bucketDimension(height, VIEWPORT_HEIGHT_STEP);
  const sidebarPresentation: SidebarPresentation =
    roundedWidth >= PERSISTENT_SIDEBAR_MIN_WIDTH ? "persistent" : "drawer";
  const chatSplitWidth =
    roundedWidth >= CHAT_SPLIT_VIEW_MIN_WIDTH
      ? CHAT_SPLIT_VIEW_MIN_WIDTH
      : CHAT_SPLIT_VIEW_MIN_WIDTH - 1;

  return {
    chatHeaderCompact: roundedWidth < CHAT_HEADER_COMPACT_WIDTH,
    chatSplitWidth,
    isDesktopNative,
    layoutHeight,
    layoutWidth,
    sidebarPresentation,
    topBarCompact: roundedWidth < TOP_BAR_COMPACT_WIDTH,
  };
}
