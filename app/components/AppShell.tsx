import React, { useEffect, useMemo, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  View,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import { usePathname } from "expo-router";
import { useAtom, useSetAtom } from "jotai";
import { Menu } from "lucide-react-native";
import { MonitorSidebar } from "@/components/MonitorSidebar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { SharedSidebar } from "@/components/SharedSidebar";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { subscribeNativeAppCommands } from "@/lib/native-app-commands";
import { useRuntimeTuning } from "@/lib/runtime-tuning";
import { useRouteShare } from "@/lib/use-route-share";
import { desktopAppZoomAtom, stepDesktopAppZoom } from "@/stores/settings";
import { sidebarOpenAtom } from "@/stores/ui";

const DRAWER_WIDTH = 320;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { width, height } = useWindowDimensions();
  const { isDesktopNative, uiScale } = useRuntimeTuning();
  const isDesktop = width >= 1024;
  const isTablet = width >= 640 && width < 1024;
  const isMobile = width < 640;

  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom);
  const setDesktopAppZoom = useSetAtom(desktopAppZoomAtom);
  const pathname = usePathname();
  const activeShare = useRouteShare();
  const isSharedRoute = pathname === "/shares" || pathname.startsWith("/shares/");
  const isMonitorRoute = pathname === "/monitor";
  const isSharedShell = isSharedRoute || Boolean(activeShare);
  const [translateX] = useState(() => new Animated.Value(-DRAWER_WIDTH));
  const Sidebar = isMonitorRoute ? MonitorSidebar : isSharedShell ? SharedSidebar : ProjectSidebar;

  // Mobile drawer should start closed — users don't expect it open on load.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, setSidebarOpen]);

  // Close the mobile drawer on navigation so picking an agent/service dismisses it.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [pathname, isMobile, setSidebarOpen]);

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: sidebarOpen ? 0 : -DRAWER_WIDTH,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [sidebarOpen, translateX]);

  useEffect(() => {
    if (!isDesktopNative) return undefined;
    return subscribeNativeAppCommands((command) => {
      if (command === "desktopZoomReset") {
        setDesktopAppZoom(100);
        return;
      }
      setDesktopAppZoom((value) => stepDesktopAppZoom(value, command === "desktopZoomIn" ? 1 : -1));
    });
  }, [isDesktopNative, setDesktopAppZoom]);

  const showHamburger = isTablet || isMobile;
  const shellZoomStyle = useMemo<ViewStyle>(
    () =>
      isDesktopNative && uiScale !== 1
        ? {
            height: height / uiScale,
            transform: [{ scale: uiScale }],
            transformOrigin: "top left",
            width: width / uiScale,
          }
        : { flex: 1 },
    [height, isDesktopNative, uiScale, width],
  );
  const hamburger = showHamburger ? (
    <Button
      variant="ghost"
      size="icon"
      accessibilityLabel="Toggle sidebar"
      onPress={() => setSidebarOpen((v) => !v)}
    >
      <Menu size={20} color="#a1a1aa" />
    </Button>
  ) : undefined;

  return (
    <View className="flex-1 bg-background">
      <View style={shellZoomStyle}>
        <TopBar left={hamburger} />
        <View className="flex-1 flex-row">
          {isDesktop ? <Sidebar /> : null}
          {isTablet && sidebarOpen ? <Sidebar /> : null}
          <View className="flex-1">{children}</View>

          {isMobile && sidebarOpen ? (
            <Pressable
              onPress={() => setSidebarOpen(false)}
              style={[
                { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 40 },
                Platform.OS === "web" ? ({ position: "fixed" } as object) : undefined,
              ]}
            />
          ) : null}
          {isMobile ? (
            <Animated.View
              pointerEvents={sidebarOpen ? "auto" : "none"}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                bottom: 0,
                width: DRAWER_WIDTH,
                zIndex: 50,
                transform: [{ translateX }],
              }}
            >
              {isMonitorRoute ? (
                <MonitorSidebar />
              ) : isSharedShell ? (
                <SharedSidebar />
              ) : (
                <ProjectSidebar />
              )}
            </Animated.View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
