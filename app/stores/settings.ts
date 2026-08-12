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
export type AgentOutputViewMode = "chat" | "split" | "terminal";
export type ExposePreviewMode = "chat" | "terminal";
export const DESKTOP_APP_ZOOM_VALUES = [80, 90, 100, 110, 120, 130, 140, 150] as const;
export type DesktopAppZoom = (typeof DESKTOP_APP_ZOOM_VALUES)[number];

export interface AppSettings {
  theme: ThemePreference;
  agentOutputViewMode: AgentOutputViewMode;
  exposePreviewMode: ExposePreviewMode;
  desktopAppZoom: DesktopAppZoom;
  chatRichTerminalColors: boolean;
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
  agentOutputViewMode: "split",
  exposePreviewMode: "terminal",
  desktopAppZoom: 110,
  chatRichTerminalColors: true,
  notifications: defaultNotificationSettings,
  activeShare: null,
});

export function normalizeAppSettings(input: AppSettings): AppSettings {
  return {
    ...defaultSettings,
    ...input,
    desktopAppZoom: normalizeDesktopAppZoom(input.desktopAppZoom),
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
export const agentOutputViewModeAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("agentOutputViewMode"),
);
export const exposePreviewModeAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("exposePreviewMode"),
);
export const desktopAppZoomAtom = focusAtom(settingsAtom, (optic) => optic.prop("desktopAppZoom"));
export const chatRichTerminalColorsAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("chatRichTerminalColors"),
);
export const notificationSettingsAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("notifications"),
);
export const activeSharedSessionAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("activeShare"),
);

export function desktopAppZoomScale(value: DesktopAppZoom) {
  return value / 100;
}

export function stepDesktopAppZoom(value: DesktopAppZoom, direction: -1 | 1): DesktopAppZoom {
  const index = DESKTOP_APP_ZOOM_VALUES.indexOf(value);
  const nextIndex = Math.min(DESKTOP_APP_ZOOM_VALUES.length - 1, Math.max(0, index + direction));
  return DESKTOP_APP_ZOOM_VALUES[nextIndex] ?? defaultSettings.desktopAppZoom;
}

function normalizeDesktopAppZoom(value: AppSettings["desktopAppZoom"]): DesktopAppZoom {
  return DESKTOP_APP_ZOOM_VALUES.includes(value as DesktopAppZoom)
    ? (value as DesktopAppZoom)
    : defaultSettings.desktopAppZoom;
}

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
