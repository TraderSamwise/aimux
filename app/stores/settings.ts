import { atomWithStorage, unwrap } from "jotai/utils";
import { focusAtom } from "jotai-optics";
import { createSsrSafeMergingJsonStorage } from "@/lib/jotai-storage";
import {
  defaultNotificationSettings,
  normalizeNotificationSettings,
  type NotificationSettings,
} from "@/lib/notification-settings";

export type ThemePreference = "system" | "light" | "dark";

export interface AppSettings {
  theme: ThemePreference;
  chatTerminalSplit: boolean;
  notifications: NotificationSettings;
}

export const defaultSettings: AppSettings = Object.freeze({
  theme: "dark",
  chatTerminalSplit: false,
  notifications: defaultNotificationSettings,
});

export function normalizeAppSettings(input: AppSettings): AppSettings {
  return {
    ...defaultSettings,
    ...input,
    notifications: normalizeNotificationSettings(input.notifications),
  };
}

const settingsStorage = createSsrSafeMergingJsonStorage(defaultSettings);

const asyncSettingsAtom = atomWithStorage<AppSettings>(
  "aimux-settings",
  defaultSettings,
  {
    ...settingsStorage,
    getItem: async (key, initialValue) =>
      normalizeAppSettings(await settingsStorage.getItem(key, initialValue)),
  },
  { getOnInit: true },
);

export const settingsAtom = unwrap(asyncSettingsAtom, (previous) => previous ?? defaultSettings);

export const themePreferenceAtom = focusAtom(settingsAtom, (optic) => optic.prop("theme"));
export const chatTerminalSplitAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("chatTerminalSplit"),
);
export const notificationSettingsAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("notifications"),
);
