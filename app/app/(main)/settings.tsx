import React from "react";
import { ScrollView, View } from "react-native";
import { useAtom } from "jotai";
import { Text } from "@/components/ui/text";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  chatTerminalSplitAtom,
  themePreferenceAtom,
  type ThemePreference,
} from "@/stores/settings";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const CHAT_TERMINAL_OPTIONS = [
  { value: "off", label: "Chat" },
  { value: "on", label: "Split" },
] as const;

export default function SettingsScreen() {
  const [themePreference, setThemePreference] = useAtom(themePreferenceAtom);
  const [chatTerminalSplit, setChatTerminalSplit] = useAtom(chatTerminalSplitAtom);

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border px-4 py-3">
        <Text className="text-base font-semibold text-foreground">Settings</Text>
      </View>
      <ScrollView className="flex-1 p-4">
        <Text className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
          Appearance
        </Text>
        <SegmentedControl<ThemePreference>
          options={THEME_OPTIONS}
          value={themePreference}
          onChange={setThemePreference}
          fullWidth
        />
        <Text className="text-xs uppercase tracking-wider text-muted-foreground mt-6 mb-2">
          Chat
        </Text>
        <SegmentedControl<"off" | "on">
          options={[...CHAT_TERMINAL_OPTIONS]}
          value={chatTerminalSplit ? "on" : "off"}
          onChange={(value) => setChatTerminalSplit(value === "on")}
          fullWidth
        />
      </ScrollView>
    </View>
  );
}
