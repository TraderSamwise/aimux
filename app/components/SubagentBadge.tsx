import React from "react";
import { Alert, Platform, Pressable } from "react-native";
import type { DesktopSession } from "@/lib/desktop-state";
import { Text } from "@/components/ui/text";

// Both surfaces render the service's label; tapping reveals its full detail
// without expanding the fixed-height chat header or the dashboard row.
export function SubagentBadge({ subagents }: { subagents?: DesktopSession["subagents"] }) {
  const label = subagents?.label?.trim();
  if (!subagents || subagents.running <= 0 || !label) return null;
  const detail = subagents.detail || label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail}
      accessibilityHint="Show working sub-agents"
      onPress={(event) => {
        event.stopPropagation();
        if (Platform.OS === "web") {
          globalThis.alert(detail);
        } else {
          Alert.alert("Sub-agents", detail);
        }
      }}
      className="shrink-0 rounded-full border border-[#3b4150] px-1.5 py-[1px]"
    >
      <Text className="text-[10px] text-[#9aa0ad]" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
