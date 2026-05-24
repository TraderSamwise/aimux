import React from "react";
import { Pressable, View } from "react-native";
import { usePathname } from "expo-router";
import { useAtomValue } from "jotai";
import { Bell } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useMainTabNavigation } from "@/lib/main-tabs";
import { cn } from "@/lib/utils";
import { notificationUnreadCountFamily } from "@/stores/notifications";
import { selectedProjectPathAtom } from "@/stores/projects";

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function NotificationBellButton({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const navigateTab = useMainTabNavigation();
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const unreadCount = useAtomValue(
    notificationUnreadCountFamily(selectedProjectPath ?? EMPTY_PROJECT_PATH),
  );
  const active = pathname.startsWith("/notifications");

  return (
    <Pressable
      accessibilityLabel={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
      onPress={() => {
        if (!active) navigateTab("inbox");
      }}
      className={cn(
        "items-center justify-center rounded-lg border border-border active:bg-accent",
        compact ? "h-9 w-9" : "h-10 w-10",
        active ? "bg-accent" : "bg-transparent",
      )}
    >
      <Bell size={compact ? 17 : 19} color={active ? "#fafafa" : "#a1a1aa"} />
      {unreadCount > 0 ? (
        <View className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-emerald-500 px-1.5 py-0.5">
          <Text className="text-center text-[10px] font-bold leading-none text-black">
            {formatCount(unreadCount)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
