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
export type MonitorTargetKind = "project-agent" | "shared-chat";
export type MonitorCaptureMode = "camera" | "audio" | "camera-audio";
export const DESKTOP_APP_ZOOM_VALUES = [80, 90, 100, 110, 120, 130, 140, 150] as const;
export type DesktopAppZoom = (typeof DESKTOP_APP_ZOOM_VALUES)[number];

export interface AppSettings {
  theme: ThemePreference;
  agentOutputViewMode: AgentOutputViewMode;
  exposePreviewMode: ExposePreviewMode;
  desktopAppZoom: DesktopAppZoom;
  chatRichTerminalColors: boolean;
  notifications: NotificationSettings;
  acceptedShares: ActiveSharedSession[];
  activeShare: ActiveSharedSession | null;
  monitor: MonitorSettings;
}

export interface ActiveSharedSession {
  shareId: string;
  ownerUserId: string;
  projectRoot: string;
  sessionId: string;
  serviceEndpoint: ServiceEndpoint;
  acceptedAt: string;
}

export interface MonitorSettings {
  intervalSeconds: number;
  targetKind: MonitorTargetKind;
  captureMode: MonitorCaptureMode;
  speechToText: boolean;
  projectPath: string | null;
  sessionId: string | null;
  shareOwnerUserId: string | null;
  shareId: string | null;
}

export const MONITOR_INTERVAL_SECONDS = [5, 10, 15, 30, 60] as const;

export const defaultSettings = Object.freeze<AppSettings>({
  theme: "dark",
  agentOutputViewMode: "split",
  exposePreviewMode: "terminal",
  desktopAppZoom: 110,
  chatRichTerminalColors: true,
  notifications: defaultNotificationSettings,
  acceptedShares: [],
  activeShare: null,
  monitor: {
    intervalSeconds: 10,
    targetKind: "project-agent",
    captureMode: "camera",
    speechToText: true,
    projectPath: null,
    sessionId: null,
    shareOwnerUserId: null,
    shareId: null,
  },
});

export function normalizeAppSettings(input: AppSettings): AppSettings {
  return {
    ...defaultSettings,
    ...input,
    desktopAppZoom: normalizeDesktopAppZoom(input.desktopAppZoom),
    notifications: normalizeNotificationSettings(input.notifications),
    acceptedShares: normalizeAcceptedShares(input.acceptedShares, input.activeShare),
    activeShare: normalizeActiveShare(input.activeShare),
    monitor: normalizeMonitorSettings(input.monitor),
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
export const acceptedSharedSessionsAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("acceptedShares"),
);
export const activeSharedSessionAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("activeShare"),
);
export const monitorSettingsAtom = focusAtom(settingsAtom, (optic) => optic.prop("monitor"));

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

function normalizeMonitorSettings(value: AppSettings["monitor"] | undefined): MonitorSettings {
  const intervalSeconds = MONITOR_INTERVAL_SECONDS.includes(
    value?.intervalSeconds as (typeof MONITOR_INTERVAL_SECONDS)[number],
  )
    ? value!.intervalSeconds
    : defaultSettings.monitor.intervalSeconds;
  const targetKind =
    value?.targetKind === "shared-chat" || value?.targetKind === "project-agent"
      ? value.targetKind
      : defaultSettings.monitor.targetKind;
  const captureMode =
    value?.captureMode === "audio" ||
    value?.captureMode === "camera-audio" ||
    value?.captureMode === "camera"
      ? value.captureMode
      : defaultSettings.monitor.captureMode;
  return {
    intervalSeconds,
    targetKind,
    captureMode,
    speechToText: value?.speechToText !== false,
    projectPath: sanitizeNullableText(value?.projectPath),
    sessionId: sanitizeNullableText(value?.sessionId),
    shareOwnerUserId: sanitizeNullableText(value?.shareOwnerUserId),
    shareId: sanitizeNullableText(value?.shareId),
  };
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

function normalizeAcceptedShares(
  value: AppSettings["acceptedShares"] | undefined,
  legacyActiveShare: AppSettings["activeShare"],
): ActiveSharedSession[] {
  const byKey = new Map<string, ActiveSharedSession>();
  for (const share of Array.isArray(value) ? value : []) {
    const normalized = normalizeActiveShare(share);
    if (normalized) byKey.set(shareKey(normalized), normalized);
  }
  const legacy = normalizeActiveShare(legacyActiveShare);
  if (legacy) byKey.set(shareKey(legacy), legacy);
  return [...byKey.values()].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
}

function shareKey(share: ActiveSharedSession): string {
  return `${share.ownerUserId}:${share.shareId}`;
}

function sanitizeNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
