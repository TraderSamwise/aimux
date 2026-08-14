import React from "react";
import { Image, Pressable, View, useWindowDimensions } from "react-native";
import { usePathname, useRouter, type Href } from "expo-router";
import { useAtomValue } from "jotai";
import { Bell, Camera, FolderKanban, MessageSquare, Share2 } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthMenu } from "@/components/AuthMenu";
import { RelayIndicator } from "@/components/RelayIndicator";
import { useAuth } from "@/lib/auth";
import { resolveChromeTopInset } from "@/lib/native-safe-area";
import { cn } from "@/lib/utils";
import { Text } from "@/components/ui/text";
import { buildMainTabHref } from "@/lib/main-tabs";
import { useRouteShare } from "@/lib/use-route-share";
import { relayConfiguredAtom } from "@/stores/relay";
import { selectedProjectPathAtom } from "@/stores/projects";

function TopBarRouteButton({
  href,
  activePrefix,
  label,
  icon: Icon,
}: {
  href: Href;
  activePrefix: string;
  label: string;
  icon: typeof MessageSquare;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const active = pathname.startsWith(activePrefix);

  return (
    <Pressable
      accessibilityLabel={label}
      onPress={() => {
        if (!active) router.navigate(href);
      }}
      className={cn(
        "h-9 w-9 items-center justify-center rounded-lg border border-border active:bg-accent",
        active ? "bg-accent" : "bg-transparent",
      )}
    >
      <Icon size={17} color={active ? "#fafafa" : "#a1a1aa"} />
    </Pressable>
  );
}

function TopLevelExperienceNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const activeShare = useRouteShare();
  const { userId } = useAuth();
  const active =
    pathname === "/monitor" || pathname.startsWith("/monitor/")
      ? "monitor"
      : pathname === "/shares" || pathname.startsWith("/shares/")
        ? "shared"
        : "projects";
  const projectTargetPath =
    activeShare && activeShare.ownerUserId === userId
      ? activeShare.projectRoot
      : selectedProjectPath;
  const compact = width < 640;

  const options = [
    {
      id: "projects",
      label: "Projects",
      icon: FolderKanban,
      href: buildMainTabHref("project", projectTargetPath),
    },
    { id: "shared", label: "Shared", icon: Share2, href: "/shares" as Href },
    { id: "monitor", label: "Monitor", icon: Camera, href: "/monitor" as Href },
  ] as const;

  return (
    <View className="ml-3 flex-row overflow-hidden rounded-lg border border-border bg-background sm:ml-5">
      {options.map((option) => {
        const Icon = option.icon;
        const selected = active === option.id;
        return (
          <Pressable
            key={option.id}
            accessibilityLabel={option.label}
            onPress={() => {
              if (!selected) router.navigate(option.href);
            }}
            className={cn(
              "h-9 flex-row items-center justify-center active:bg-accent",
              compact ? "w-9" : "gap-2 px-3",
              selected ? "bg-accent" : "bg-transparent",
            )}
          >
            <Icon size={15} color={selected ? "#fafafa" : "#a1a1aa"} />
            {!compact ? (
              <Text
                className={cn(
                  "text-[13px] font-medium",
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {option.label}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function TopBar({ left }: { left?: React.ReactNode }) {
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInset = resolveChromeTopInset(insets.top);
  const compact = width < 640;

  return (
    <View
      className="z-30 flex-row items-center justify-between border-b border-border bg-card px-4"
      style={{ height: 56 + topInset, paddingTop: topInset }}
    >
      {left ? <View className="-ml-1 mr-2">{left}</View> : null}
      <View className="flex-row items-center">
        <Image
          source={require("@/assets/images/icon.png")}
          style={{ width: 24, height: 24, borderRadius: 6, marginRight: 8 }}
          resizeMode="contain"
          accessibilityLabel="aimux logo"
        />
        {!compact ? (
          <Text className="font-mono text-[17px] font-bold text-foreground">aimux</Text>
        ) : null}
      </View>
      <TopLevelExperienceNav />
      <View className="min-w-2 flex-1" />
      {relayConfigured ? (
        <View className="mr-3">
          <RelayIndicator />
        </View>
      ) : null}
      {!compact ? (
        <>
          <View className="mr-2">
            <TopBarRouteButton
              href={"/global-threads" as Href}
              activePrefix="/global-threads"
              label="Global threads"
              icon={MessageSquare}
            />
          </View>
          <View className="mr-3">
            <TopBarRouteButton
              href={"/global-notifications" as Href}
              activePrefix="/global-notifications"
              label="Global inbox"
              icon={Bell}
            />
          </View>
        </>
      ) : (
        <View className="mr-2" />
      )}
      <AuthMenu />
    </View>
  );
}
