import React, { createContext, useContext, useMemo } from "react";
import {
  createResponsiveViewportValue,
  type ResponsiveViewport,
} from "@/lib/responsive-viewport-core";
import { isDesktopNativeRuntime } from "@/lib/runtime-tuning";

export function useResponsiveViewportValue(width: number, height: number): ResponsiveViewport {
  const roundedWidth = Math.max(0, Math.round(width));
  const roundedHeight = Math.max(0, Math.round(height));
  const isDesktopNative = isDesktopNativeRuntime(roundedWidth, roundedHeight);
  const value = createResponsiveViewportValue({ height, isDesktopNative, width });

  return useMemo(
    () => ({
      chatHeaderCompact: value.chatHeaderCompact,
      chatSplitWidth: value.chatSplitWidth,
      isDesktopNative: value.isDesktopNative,
      layoutHeight: value.layoutHeight,
      layoutWidth: value.layoutWidth,
      sidebarPresentation: value.sidebarPresentation,
      topBarCompact: value.topBarCompact,
    }),
    [
      value.chatHeaderCompact,
      value.chatSplitWidth,
      value.isDesktopNative,
      value.layoutHeight,
      value.layoutWidth,
      value.sidebarPresentation,
      value.topBarCompact,
    ],
  );
}

const ResponsiveViewportContext = createContext<ResponsiveViewport | null>(null);

export function ResponsiveViewportProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: ResponsiveViewport;
}) {
  return (
    <ResponsiveViewportContext.Provider value={value}>
      {children}
    </ResponsiveViewportContext.Provider>
  );
}

export function useResponsiveViewport(): ResponsiveViewport {
  const value = useContext(ResponsiveViewportContext);
  if (!value) {
    throw new Error("useResponsiveViewport must be used inside ResponsiveViewportProvider");
  }
  return value;
}
