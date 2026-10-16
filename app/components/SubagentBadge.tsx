import React from "react";
import { Alert, Platform, Pressable } from "react-native";
import type { DesktopSession } from "@/lib/desktop-state";
import { rowChipColors, type RowChipTone } from "@/lib/row-chips";
import { Text } from "@/components/ui/text";

// Both surfaces render the service's label; tapping reveals its full detail
// without expanding the fixed-height chat header or the dashboard row.
//
// On a row this is one chip in the published order, so it takes the tone it
// was published with: hardcoding grey here painted a live agent's sub-agents
// muted in the app while the terminal painted them as work. The chat header
// has no chip beside it and keeps the muted default.
export function SubagentBadge({
  subagents,
  tone = "muted",
}: {
  subagents?: DesktopSession["subagents"];
  tone?: RowChipTone;
}) {
  const label = subagents?.label?.trim();
  if (!subagents || subagents.running <= 0 || !label) return null;
  const detail = subagents.detail || label;
  const colors = rowChipColors(tone);
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
      className="shrink-0 rounded-full border px-1.5 py-[1px]"
      style={{ borderColor: colors.border }}
    >
      <Text className="text-[10px]" style={{ color: colors.text }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
