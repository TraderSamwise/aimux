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
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { KeyRound, Menu } from "lucide-react-native";
import { MonitorSidebar } from "@/components/MonitorSidebar";
import { PairDeviceDialog, APPROVE_COMMAND } from "@/components/PairDeviceDialog";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { SharedSidebar } from "@/components/SharedSidebar";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { resolveChromeTopInset } from "@/lib/native-safe-area";
import { subscribeNativeAppCommands } from "@/lib/native-app-commands";
import { useRuntimeTuning } from "@/lib/runtime-tuning";
import { useRouteShare } from "@/lib/use-route-share";
import { relayConfiguredAtom, relayPendingApprovalAtom, relayStatusAtom } from "@/stores/relay";
import { desktopAppZoomAtom, stepDesktopAppZoom } from "@/stores/settings";
import { appChromeCollapsedAtom, sidebarOpenAtom } from "@/stores/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const DRAWER_WIDTH = 320;
const APP_CHROME_COLLAPSE_ANIMATION_MS = 140;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { width, height } = useWindowDimensions();
  const { isDesktopNative, uiScale } = useRuntimeTuning();
  const isDesktop = width >= 1024;
  const isTablet = width >= 640 && width < 1024;
  const isMobile = width < 640;
  const safeAreaInsets = useSafeAreaInsets();
  const topInset = resolveChromeTopInset(safeAreaInsets.top);

  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom);
  const setDesktopAppZoom = useSetAtom(desktopAppZoomAtom);
  const appChromeCollapsed = useAtomValue(appChromeCollapsedAtom) && isMobile;
  const pathname = usePathname();
  const activeShare = useRouteShare();
  const isSharedRoute = pathname === "/shares" || pathname.startsWith("/shares/");
  const isMonitorRoute = pathname === "/monitor";
  const isSharedShell = isSharedRoute || Boolean(activeShare);
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const pendingApproval = useAtomValue(relayPendingApprovalAtom);
  const [pairingDialogOpen, setPairingDialogOpen] = useState(false);
  const [translateX] = useState(() => new Animated.Value(-DRAWER_WIDTH));
  const [appChromeCollapseProgress] = useState(() => new Animated.Value(0));
  const [appChromeHeight, setAppChromeHeight] = useState(56 + topInset);
  const Sidebar = isMonitorRoute ? MonitorSidebar : isSharedShell ? SharedSidebar : ProjectSidebar;
  const showPairingBanner = relayConfigured && relayStatus === "device_pending" && !isSharedShell;

  // Mobile drawer should start closed — users don't expect it open on load.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, setSidebarOpen]);

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: sidebarOpen ? 0 : -DRAWER_WIDTH,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [sidebarOpen, translateX]);

  useEffect(() => {
    Animated.timing(appChromeCollapseProgress, {
      toValue: appChromeCollapsed ? 1 : 0,
      duration: APP_CHROME_COLLAPSE_ANIMATION_MS,
      useNativeDriver: false,
    }).start();
  }, [appChromeCollapseProgress, appChromeCollapsed]);

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
        <Animated.View
          pointerEvents={appChromeCollapsed ? "none" : "auto"}
          style={{
            height: appChromeCollapseProgress.interpolate({
              inputRange: [0, 1],
              outputRange: [appChromeHeight, 0],
            }),
            opacity: appChromeCollapseProgress.interpolate({
              inputRange: [0, 0.7, 1],
              outputRange: [1, 0.08, 0],
            }),
            overflow: "hidden",
            transform: [
              {
                translateY: appChromeCollapseProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, -Math.max(1, appChromeHeight)],
                }),
              },
            ],
          }}
        >
          <View
            onLayout={(event) => {
              const nextHeight = Math.ceil(event.nativeEvent.layout.height);
              if (nextHeight > 0) setAppChromeHeight(nextHeight);
            }}
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
          </View>
        </Animated.View>
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
        {pairingDialogOpen ? (
          <PairDeviceDialog onDismiss={() => setPairingDialogOpen(false)} />
        ) : null}
      </View>
    </View>
  );
}
