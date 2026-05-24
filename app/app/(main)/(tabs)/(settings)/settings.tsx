import React from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useAtom } from "jotai";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from "@/lib/browser-notifications";
import type { NotificationSettings } from "@/lib/notification-settings";
import {
  chatTerminalSplitAtom,
  notificationSettingsAtom,
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

const ENABLED_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const;

export default function SettingsScreen() {
  const [themePreference, setThemePreference] = useAtom(themePreferenceAtom);
  const [chatTerminalSplit, setChatTerminalSplit] = useAtom(chatTerminalSplitAtom);
  const [notificationSettings, setNotificationSettings] = useAtom(notificationSettingsAtom);
  const [browserPermission, setBrowserPermission] = React.useState<BrowserNotificationPermission>(
    () => getBrowserNotificationPermission(),
  );

  function updateNotifications(next: NotificationSettings) {
    setNotificationSettings(next);
  }

  function setAgentNotification(
    key: keyof NotificationSettings["categories"]["agent"],
    value: boolean,
  ) {
    updateNotifications({
      ...notificationSettings,
      categories: {
        ...notificationSettings.categories,
        agent: {
          ...notificationSettings.categories.agent,
          [key]: value,
        },
      },
    });
  }

  function setBrowserChannel(value: boolean) {
    updateNotifications({
      ...notificationSettings,
      channels: {
        ...notificationSettings.channels,
        browser: value,
      },
    });
  }

  async function requestBrowserPermission() {
    setBrowserPermission(await requestBrowserNotificationPermission());
  }

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
        <Text className="text-xs uppercase tracking-wider text-muted-foreground mt-6 mb-2">
          Notifications
        </Text>
        <SegmentedControl<"off" | "on">
          options={[...ENABLED_OPTIONS]}
          value={notificationSettings.enabled ? "on" : "off"}
          onChange={(value) =>
            updateNotifications({
              ...notificationSettings,
              enabled: value === "on",
            })
          }
          fullWidth
        />
        {Platform.OS === "web" ? (
          <View className="mt-3 flex-row items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-3">
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium text-foreground">Browser</Text>
              <Text className="mt-1 text-xs text-muted-foreground">
                {browserPermission === "granted" ? "Allowed" : "Permission required"}
              </Text>
            </View>
            <SegmentedControl<"off" | "on">
              options={[...ENABLED_OPTIONS]}
              value={notificationSettings.channels.browser ? "on" : "off"}
              onChange={(value) => setBrowserChannel(value === "on")}
            />
            {browserPermission !== "granted" && (
              <Button
                size="sm"
                variant="outline"
                label="Allow"
                onPress={() => void requestBrowserPermission()}
                disabled={browserPermission === "unsupported"}
              />
            )}
          </View>
        ) : (
          <View className="mt-3 rounded-lg border border-border bg-secondary/40 px-3 py-3">
            <Text className="text-sm font-medium text-foreground">Push</Text>
            <Text className="mt-1 text-xs text-muted-foreground">Native delivery pending</Text>
          </View>
        )}

        <Text className="text-xs uppercase tracking-wider text-muted-foreground mt-6 mb-2">
          Agent Alerts
        </Text>
        <View className="overflow-hidden rounded-lg border border-border">
          <SettingToggle
            label="Agent alerts"
            value={notificationSettings.categories.agent.enabled}
            onChange={(value) => setAgentNotification("enabled", value)}
          />
          <SettingToggle
            label="On you"
            value={notificationSettings.categories.agent.needsInput}
            onChange={(value) => setAgentNotification("needsInput", value)}
          />
          <SettingToggle
            label="Blocked"
            value={notificationSettings.categories.agent.blocked}
            onChange={(value) => setAgentNotification("blocked", value)}
          />
          <SettingToggle
            label="Errors"
            value={notificationSettings.categories.agent.errors}
            onChange={(value) => setAgentNotification("errors", value)}
          />
          <SettingToggle
            label="Completed"
            value={notificationSettings.categories.agent.completed}
            onChange={(value) => setAgentNotification("completed", value)}
          />
          <SettingToggle
            label="New activity"
            value={notificationSettings.categories.agent.activity}
            onChange={(value) => setAgentNotification("activity", value)}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function SettingToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Pressable
      className="flex-row items-center justify-between border-b border-border px-3 py-3 last:border-b-0 active:opacity-70"
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
    >
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <View
        className={[
          "h-6 w-11 justify-center rounded-full px-0.5",
          value ? "items-end bg-primary" : "items-start bg-muted",
        ].join(" ")}
      >
        <View className="h-5 w-5 rounded-full bg-background" />
      </View>
    </Pressable>
  );
}
