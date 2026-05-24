import { atomWithStorage, unwrap } from "jotai/utils";
import { focusAtom } from "jotai-optics";
import { createSsrSafeMergingJsonStorage } from "@/lib/jotai-storage";
import {
  defaultNotificationSettings,
  normalizeNotificationSettings,
  type NotificationSettings,
} from "@/lib/notification-settings";
import type { ServiceEndpoint } from "@/lib/daemon-url";

export type ThemePreference = "system" | "light" | "dark";

export interface AppSettings {
  theme: ThemePreference;
  chatTerminalSplit: boolean;
  notifications: NotificationSettings;
  activeShare: ActiveSharedSession | null;
}

export interface ActiveSharedSession {
  shareId: string;
  ownerUserId: string;
  projectRoot: string;
  sessionId: string;
  serviceEndpoint: ServiceEndpoint;
  acceptedAt: string;
}

export const defaultSettings: AppSettings = Object.freeze({
  theme: "dark",
  chatTerminalSplit: false,
  notifications: defaultNotificationSettings,
  activeShare: null,
});

export function normalizeAppSettings(input: AppSettings): AppSettings {
  return {
    ...defaultSettings,
    ...input,
    notifications: normalizeNotificationSettings(input.notifications),
    activeShare: normalizeActiveShare(input.activeShare),
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
export const activeSharedSessionAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("activeShare"),
);

function normalizeActiveShare(value: AppSettings["activeShare"]): ActiveSharedSession | null {
  if (!value?.shareId || !value.ownerUserId || !value.projectRoot || !value.sessionId) return null;
  const host = value.serviceEndpoint?.host?.trim();
  const port = Number(value.serviceEndpoint?.port);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return {
    shareId: value.shareId,
    ownerUserId: value.ownerUserId,
    projectRoot: value.projectRoot,
    sessionId: value.sessionId,
    serviceEndpoint: { host, port },
    acceptedAt: value.acceptedAt || new Date(0).toISOString(),
  };
}
