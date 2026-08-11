import React from "react";
import { Platform, Pressable, View } from "react-native";
import { useAtom, useAtomValue } from "jotai";
import { Page, PageHeader } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAuth } from "@/lib/auth";
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from "@/lib/browser-notifications";
import { env } from "@/lib/env";
import type { NotificationSettings } from "@/lib/notification-settings";
import { registerSecurityPushToken, sendSecurityTestPush } from "@/lib/push-registration";
import { getErrorMessage } from "@/lib/request-errors";
import {
  activeSharedSessionAtom,
  chatRichTerminalColorsAtom,
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
  const [chatRichTerminalColors, setChatRichTerminalColors] = useAtom(chatRichTerminalColorsAtom);
  const [notificationSettings, setNotificationSettings] = useAtom(notificationSettingsAtom);
  const activeShare = useAtomValue(activeSharedSessionAtom);
  const { getToken } = useAuth();
  const [browserPermission, setBrowserPermission] = React.useState<BrowserNotificationPermission>(
    () => getBrowserNotificationPermission(),
  );
  const [pushStatus, setPushStatus] = React.useState<string | null>(null);
  const [pushBusy, setPushBusy] = React.useState(false);

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

  async function setPushChannel(value: boolean) {
    if (pushBusy) return;
    const relayUrl = env.AIMUX_RELAY_URL;
    if (!value) {
      updateNotifications({
        ...notificationSettings,
        channels: {
          ...notificationSettings.channels,
          push: false,
        },
      });
      setPushStatus("Off");
      if (relayUrl) {
        void registerSecurityPushToken(relayUrl, getToken, {
          ownerUserId: activeShare?.ownerUserId,
          shareId: activeShare?.shareId,
          agentAlerts: false,
        }).catch(() => {});
      }
      return;
    }

    if (!relayUrl) {
      setPushStatus("Requires relay mode");
      return;
    }

    setPushBusy(true);
    setPushStatus("Requesting permission");
    try {
      const result = await registerSecurityPushToken(relayUrl, getToken, {
        ownerUserId: activeShare?.ownerUserId,
        shareId: activeShare?.shareId,
        agentAlerts: true,
        requestPermission: true,
      });
      if (result.status === "registered") {
        updateNotifications({
          ...notificationSettings,
          enabled: true,
          channels: {
            ...notificationSettings.channels,
            push: true,
          },
        });
        setPushStatus("Registered");
      } else if (result.status === "permission_denied") {
        setPushStatus("Permission denied in iOS Settings");
      } else if (result.status === "missing_auth") {
        setPushStatus("Sign in required");
      } else {
        setPushStatus("Not supported on this device");
      }
    } catch (err) {
      setPushStatus(getErrorMessage(err));
    } finally {
      setPushBusy(false);
    }
  }

  async function sendTestPush() {
    if (pushBusy) return;
    const relayUrl = env.AIMUX_RELAY_URL;
    if (!relayUrl) {
      setPushStatus("Requires relay mode");
      return;
    }
    setPushBusy(true);
    setPushStatus("Registering");
    try {
      const context = {
        ownerUserId: activeShare?.ownerUserId,
        shareId: activeShare?.shareId,
      };
      const result = await registerSecurityPushToken(relayUrl, getToken, {
        ...context,
        agentAlerts: true,
        requestPermission: true,
      });
      if (result.status !== "registered") {
        setPushStatus(
          result.status === "missing_auth" ? "Sign in required" : "Permission required",
        );
        return;
      }
      setPushStatus("Sending test");
      await sendSecurityTestPush(relayUrl, getToken, context);
      updateNotifications({
        ...notificationSettings,
        enabled: true,
        channels: {
          ...notificationSettings.channels,
          push: true,
        },
      });
      setPushStatus("Test sent");
    } catch (err) {
      setPushStatus(getErrorMessage(err));
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Settings" subtitle="Preferences for the app and agent alerts." />
      <Text className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
        Appearance
      </Text>
      <SegmentedControl<ThemePreference>
        options={THEME_OPTIONS}
        value={themePreference}
        onChange={setThemePreference}
        fullWidth
      />
      <Text className="mb-2 mt-6 text-xs uppercase tracking-wider text-muted-foreground">Chat</Text>
      <SegmentedControl<"off" | "on">
        options={[...CHAT_TERMINAL_OPTIONS]}
        value={chatTerminalSplit ? "on" : "off"}
        onChange={(value) => setChatTerminalSplit(value === "on")}
        fullWidth
      />
      <View className="mt-3 overflow-hidden rounded-lg border border-border">
        <SettingToggle
          label="Terminal colors"
          value={chatRichTerminalColors}
          onChange={setChatRichTerminalColors}
        />
      </View>
      <Text className="mb-2 mt-6 text-xs uppercase tracking-wider text-muted-foreground">
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
        <View className="mt-3 flex-row items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-3">
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-medium text-foreground">Push</Text>
            <Text className="mt-1 text-xs text-muted-foreground">
              {pushBusy
                ? pushStatus
                : (pushStatus ?? (notificationSettings.channels.push ? "On" : "Off"))}
            </Text>
          </View>
          <SegmentedControl<"off" | "on">
            options={[...ENABLED_OPTIONS]}
            value={notificationSettings.channels.push ? "on" : "off"}
            onChange={(value) => void setPushChannel(value === "on")}
          />
          {notificationSettings.channels.push && (
            <Button
              size="sm"
              variant="outline"
              label="Test"
              onPress={() => void sendTestPush()}
              disabled={pushBusy}
            />
          )}
        </View>
      )}

      <Text className="mb-2 mt-6 text-xs uppercase tracking-wider text-muted-foreground">
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
    </Page>
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
