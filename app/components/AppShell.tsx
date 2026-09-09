import React, { useEffect, useMemo, useState } from "react";
import {
  Animated as RNAnimated,
  Platform,
  Pressable,
  View,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import { usePathname } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { KeyRound, Menu } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Reanimated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { MonitorSidebar } from "@/components/MonitorSidebar";
import { PairDeviceDialog, APPROVE_COMMAND } from "@/components/PairDeviceDialog";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { SharedSidebar } from "@/components/SharedSidebar";
import { ChatChromeMotion } from "@/components/ChatChromeMotion";
import { ChatTopEdgeFade } from "@/components/ChatTopEdgeFade";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { chatTopBarReserveHeight } from "@/lib/chat-chrome-layout";
import { isDesktopZoomCommand, subscribeNativeAppCommands } from "@/lib/native-app-commands";
import { resolveChromeTopInset } from "@/lib/native-safe-area";
import { ResponsiveViewportProvider, useResponsiveViewportValue } from "@/lib/responsive-viewport";
import { useRouteShare } from "@/lib/use-route-share";
import { relayConfiguredAtom, relayPendingApprovalAtom, relayStatusAtom } from "@/stores/relay";
import { desktopAppZoomAtom, desktopAppZoomScale, stepDesktopAppZoom } from "@/stores/settings";
import { chatChromeVisibleAtom, sidebarOpenAtom } from "@/stores/ui";

const DRAWER_WIDTH = 320;
const SIDEBAR_SURFACE_MOTION_MS = 110;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const viewport = useResponsiveViewportValue(width, height);
  const desktopAppZoom = useAtomValue(desktopAppZoomAtom);
  const isDesktopNative = viewport.isDesktopNative;
  const uiScale = isDesktopNative ? desktopAppZoomScale(desktopAppZoom) : 1;
  const sidebarPresentation = viewport.sidebarPresentation;
  const usesPersistentSidebar = sidebarPresentation === "persistent";
  const usesDrawerSidebar = !usesPersistentSidebar;

  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom);
  const setDesktopAppZoom = useSetAtom(desktopAppZoomAtom);
  const pathname = usePathname();
  const chatChromeVisible = useAtomValue(chatChromeVisibleAtom);
  const activeShare = useRouteShare();
  const isSharedRoute = pathname === "/shares" || pathname.startsWith("/shares/");
  const isMonitorRoute = pathname === "/monitor";
  const isSharedShell = isSharedRoute || Boolean(activeShare);
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const pendingApproval = useAtomValue(relayPendingApprovalAtom);
  const [pairingDialogOpen, setPairingDialogOpen] = useState(false);
  const [translateX] = useState(() => new RNAnimated.Value(-DRAWER_WIDTH));
  const persistentSidebarProgress = useSharedValue(usesPersistentSidebar && sidebarOpen ? 1 : 0);
  const Sidebar = isMonitorRoute ? MonitorSidebar : isSharedShell ? SharedSidebar : ProjectSidebar;
  const showPairingBanner = relayConfigured && relayStatus === "device_pending" && !isSharedShell;
  const overlayTopChrome = isChatRoute(pathname);
  const resolvedTopInset = resolveChromeTopInset(insets.top);
  const topChromeHideDistance = chatTopBarReserveHeight({
    pairingBannerVisible: showPairingBanner,
    topInset: resolvedTopInset,
  });

  useEffect(() => {
    if (!usesPersistentSidebar) setSidebarOpen(false);
  }, [setSidebarOpen, usesPersistentSidebar]);

  useEffect(() => {
    if (!usesDrawerSidebar) return;
    RNAnimated.timing(translateX, {
      toValue: sidebarOpen ? 0 : -DRAWER_WIDTH,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [sidebarOpen, translateX, usesDrawerSidebar]);

  useEffect(() => {
    persistentSidebarProgress.value = withTiming(usesPersistentSidebar && sidebarOpen ? 1 : 0, {
      duration: SIDEBAR_SURFACE_MOTION_MS,
      reduceMotion: ReduceMotion.System,
    });
  }, [persistentSidebarProgress, sidebarOpen, usesPersistentSidebar]);

  useEffect(() => {
    if (!isDesktopNative) return undefined;
    return subscribeNativeAppCommands((command) => {
      if (!isDesktopZoomCommand(command)) return;
      if (command === "desktopZoomReset") {
        setDesktopAppZoom(100);
        return;
      }
      setDesktopAppZoom((value) => stepDesktopAppZoom(value, command === "desktopZoomIn" ? 1 : -1));
    });
  }, [isDesktopNative, setDesktopAppZoom]);

  const persistentSidebarInnerStyle = useAnimatedStyle(() => ({
    opacity: persistentSidebarProgress.value,
    transform: [{ translateX: -10 * (1 - persistentSidebarProgress.value) }],
  }));
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
  const hamburger = useMemo(
    () => (
      <Button
        variant="ghost"
        size="icon"
        accessibilityLabel="Toggle sidebar"
        onPress={() => setSidebarOpen((v) => !v)}
      >
        <Menu size={20} color="#a1a1aa" />
      </Button>
    ),
    [setSidebarOpen],
  );
  const desktopSidebarSurface = overlayTopChrome ? (
    <View className="flex-1 bg-[#161719]">
      <View
        style={{
          bottom: 0,
          left: 0,
          position: "absolute",
          right: 0,
          top: topChromeHideDistance,
        }}
      >
        <Sidebar />
      </View>
    </View>
  ) : (
    <Sidebar />
  );
  const mobileSidebarSurface = overlayTopChrome ? (
    <View className="flex-1 bg-[#161719]">
      <View
        style={{
          bottom: 0,
          left: 0,
          position: "absolute",
          right: 0,
          top: resolvedTopInset,
        }}
      >
        <Sidebar />
      </View>
    </View>
  ) : (
    <Sidebar />
  );
  return (
    <View className="flex-1 bg-background">
      <ResponsiveViewportProvider value={viewport}>
        <View style={shellZoomStyle}>
          <View
            style={
              overlayTopChrome
                ? { left: 0, position: "absolute", right: 0, top: 0, zIndex: 60 }
                : { flexShrink: 0 }
            }
          >
            <ChatChromeMotion
              direction="top"
              distance={topChromeHideDistance}
              visible={!overlayTopChrome || chatChromeVisible}
            >
              <TopBar left={hamburger} />
              {showPairingBanner ? (
                <Pressable
                  accessibilityLabel="Pair this browser"
                  accessibilityHint={`Run ${APPROVE_COMMAND} on your Mac to approve this device.`}
                  onPress={() => setPairingDialogOpen(true)}
                  className="flex-row items-center border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 active:bg-amber-500/20"
                >
                  <KeyRound size={16} color="#fbbf24" />
                  <View className="ml-2 min-w-0 flex-1">
                    <Text className="text-[13px] font-semibold text-amber-200">
                      Approve this browser to connect
                    </Text>
                    <Text className="mt-0.5 text-[12px] text-amber-100/80" numberOfLines={1}>
                      Run {APPROVE_COMMAND}
                      {pendingApproval?.approvalCode
                        ? ` and match code ${pendingApproval.approvalCode}`
                        : ""}
                      .
                    </Text>
                  </View>
                </Pressable>
              ) : null}
            </ChatChromeMotion>
          </View>
          {overlayTopChrome ? (
            <ChatTopEdgeFade topInset={resolvedTopInset} visible={!chatChromeVisible} />
          ) : null}
          <View className="flex-1 flex-row">
            {usesPersistentSidebar ? (
              <Reanimated.View
                pointerEvents={sidebarOpen ? "auto" : "none"}
                style={[
                  {
                    backgroundColor: "#161719",
                    flexShrink: 0,
                    height: "100%",
                    overflow: "hidden",
                    width: sidebarOpen ? DRAWER_WIDTH : 0,
                  },
                ]}
              >
                <Reanimated.View
                  style={[{ height: "100%", width: DRAWER_WIDTH }, persistentSidebarInnerStyle]}
                >
                  {desktopSidebarSurface}
                </Reanimated.View>
              </Reanimated.View>
            ) : null}
            <View className="flex-1">{children}</View>

            {usesDrawerSidebar && sidebarOpen ? (
              <Pressable
                onPress={() => setSidebarOpen(false)}
                style={[
                  { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 80 },
                  Platform.OS === "web" ? ({ position: "fixed" } as object) : undefined,
                ]}
              />
            ) : null}
            {usesDrawerSidebar ? (
              <RNAnimated.View
                pointerEvents={sidebarOpen ? "auto" : "none"}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  bottom: 0,
                  width: DRAWER_WIDTH,
                  zIndex: 90,
                  transform: [{ translateX }],
                }}
              >
                {mobileSidebarSurface}
              </RNAnimated.View>
            ) : null}
          </View>
          {pairingDialogOpen ? (
            <PairDeviceDialog onDismiss={() => setPairingDialogOpen(false)} />
          ) : null}
        </View>
      </ResponsiveViewportProvider>
    </View>
  );
}

function isChatRoute(pathname: string) {
  return (
    (pathname.startsWith("/agent/") && pathname.endsWith("/chat")) ||
    (pathname.startsWith("/shares/") && pathname.includes("/agent/") && pathname.endsWith("/chat"))
  );
}
