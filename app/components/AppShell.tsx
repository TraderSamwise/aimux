import React, { useEffect, useState } from "react";
import { Animated, Platform, Pressable, View, useWindowDimensions } from "react-native";
import { usePathname } from "expo-router";
import { useAtom } from "jotai";
import { Menu } from "lucide-react-native";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { sidebarOpenAtom } from "@/stores/ui";

const DRAWER_WIDTH = 320;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const isDesktop = width >= 1024;
  const isTablet = width >= 640 && width < 1024;
  const isMobile = width < 640;

  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom);
  const pathname = usePathname();
  const [translateX] = useState(() => new Animated.Value(-DRAWER_WIDTH));

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

  const showHamburger = isTablet || isMobile;
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
      <TopBar left={hamburger} />
      <View className="flex-1 flex-row">
        {isDesktop ? <ProjectSidebar /> : null}
        {isTablet && sidebarOpen ? <ProjectSidebar /> : null}
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
            <ProjectSidebar showBottomNav={false} />
          </Animated.View>
        ) : null}
      </View>
    </View>
  );
}
