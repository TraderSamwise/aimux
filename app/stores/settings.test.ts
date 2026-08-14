import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import AsyncStorage from "@react-native-async-storage/async-storage";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
      clear: vi.fn(async () => {
        storage.clear();
      }),
    },
  };
});

let settingsModule: typeof import("./settings");

beforeAll(async () => {
  vi.stubGlobal("window", globalThis);
  settingsModule = await import("./settings");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("settings store", () => {
  it("keeps durable UI settings in one persisted settings object", () => {
    expect(settingsModule.defaultSettings).toEqual({
      theme: "dark",
      agentOutputViewMode: "split",
      exposePreviewMode: "terminal",
      desktopAppZoom: 110,
      chatRichTerminalColors: true,
      acceptedShares: [],
      activeShare: null,
      monitor: {
        intervalSeconds: 10,
        targetKind: "project-agent",
        captureMode: "camera",
        speechToText: true,
        speechOnDeviceOnly: true,
        speechInterimResults: true,
        speechLanguage: "en-US",
        audioSampleRate: 16000,
        projectPath: null,
        sessionId: null,
        shareOwnerUserId: null,
        shareId: null,
      },
      notifications: {
        enabled: false,
        channels: {
          browser: true,
          push: false,
        },
        categories: {
          agent: {
            enabled: true,
            needsInput: true,
            blocked: true,
            errors: true,
            completed: false,
            activity: false,
          },
          system: {
            enabled: false,
            relayStatus: false,
            projectHealth: false,
          },
        },
      },
    });
  });

  it("exposes focused atoms for individual settings", () => {
    const store = createStore();

    expect(store.get(settingsModule.themePreferenceAtom)).toBe("dark");
    expect(store.get(settingsModule.agentOutputViewModeAtom)).toBe("split");
    expect(store.get(settingsModule.exposePreviewModeAtom)).toBe("terminal");
    expect(store.get(settingsModule.desktopAppZoomAtom)).toBe(110);
    expect(store.get(settingsModule.chatRichTerminalColorsAtom)).toBe(true);
    expect(store.get(settingsModule.acceptedSharedSessionsAtom)).toEqual([]);
    expect(store.get(settingsModule.activeSharedSessionAtom)).toBeNull();
    expect(store.get(settingsModule.monitorSettingsAtom).intervalSeconds).toBe(10);
    expect(store.get(settingsModule.notificationSettingsAtom).enabled).toBe(false);

    store.set(settingsModule.agentOutputViewModeAtom, "terminal");
    store.set(settingsModule.exposePreviewModeAtom, "chat");
    store.set(settingsModule.desktopAppZoomAtom, 130);
    store.set(settingsModule.chatRichTerminalColorsAtom, true);
    store.set(settingsModule.notificationSettingsAtom, {
      ...store.get(settingsModule.notificationSettingsAtom),
      enabled: true,
    });
    store.set(settingsModule.monitorSettingsAtom, {
      ...store.get(settingsModule.monitorSettingsAtom),
      intervalSeconds: 30,
      targetKind: "shared-chat",
      captureMode: "camera-audio",
      speechToText: false,
      speechOnDeviceOnly: false,
      speechInterimResults: false,
      speechLanguage: "en-GB",
      audioSampleRate: 24000,
      sessionId: "claude-1",
    });

    expect(store.get(settingsModule.agentOutputViewModeAtom)).toBe("terminal");
    expect(store.get(settingsModule.exposePreviewModeAtom)).toBe("chat");
    expect(store.get(settingsModule.desktopAppZoomAtom)).toBe(130);
    expect(store.get(settingsModule.chatRichTerminalColorsAtom)).toBe(true);
    expect(store.get(settingsModule.settingsAtom).agentOutputViewMode).toBe("terminal");
    expect(store.get(settingsModule.settingsAtom).exposePreviewMode).toBe("chat");
    expect(store.get(settingsModule.settingsAtom).desktopAppZoom).toBe(130);
    expect(store.get(settingsModule.settingsAtom).chatRichTerminalColors).toBe(true);
    expect(store.get(settingsModule.settingsAtom).notifications.enabled).toBe(true);
    expect(store.get(settingsModule.settingsAtom).monitor).toMatchObject({
      intervalSeconds: 30,
      targetKind: "shared-chat",
      captureMode: "camera-audio",
      speechToText: false,
      speechOnDeviceOnly: false,
      speechInterimResults: false,
      speechLanguage: "en-GB",
      audioSampleRate: 24000,
      sessionId: "claude-1",
    });
  });

  it("normalizes older persisted settings without notification keys", () => {
    expect(
      settingsModule.normalizeAppSettings({
        theme: "light",
      } as import("./settings").AppSettings),
    ).toEqual({
      ...settingsModule.defaultSettings,
      theme: "light",
      agentOutputViewMode: "split",
      exposePreviewMode: "terminal",
      desktopAppZoom: 110,
      chatRichTerminalColors: true,
      acceptedShares: [],
      activeShare: null,
      monitor: settingsModule.defaultSettings.monitor,
    });
  });

  it("persists focused atom writes to aimux-settings", async () => {
    const store = createStore();

    store.set(settingsModule.themePreferenceAtom, "light");
    store.set(settingsModule.agentOutputViewModeAtom, "terminal");
    store.set(settingsModule.exposePreviewModeAtom, "chat");
    store.set(settingsModule.desktopAppZoomAtom, 150);
    store.set(settingsModule.chatRichTerminalColorsAtom, true);
    store.set(settingsModule.notificationSettingsAtom, {
      ...store.get(settingsModule.notificationSettingsAtom),
      enabled: true,
      categories: {
        ...store.get(settingsModule.notificationSettingsAtom).categories,
        agent: {
          ...store.get(settingsModule.notificationSettingsAtom).categories.agent,
          completed: true,
        },
      },
    });
    store.set(settingsModule.activeSharedSessionAtom, {
      shareId: "share_1",
      ownerUserId: "user_owner",
      projectRoot: "/repo",
      sessionId: "claude-1",
      serviceEndpoint: { host: "127.0.0.1", port: 43192 },
      acceptedAt: "2026-05-24T00:00:00.000Z",
    });
    store.set(settingsModule.acceptedSharedSessionsAtom, [
      {
        shareId: "share_1",
        ownerUserId: "user_owner",
        projectRoot: "/repo",
        sessionId: "claude-1",
        serviceEndpoint: { host: "127.0.0.1", port: 43192 },
        acceptedAt: "2026-05-24T00:00:00.000Z",
      },
    ]);
    store.set(settingsModule.monitorSettingsAtom, {
      intervalSeconds: 15,
      targetKind: "project-agent",
      captureMode: "camera",
      speechToText: true,
      speechOnDeviceOnly: true,
      speechInterimResults: true,
      speechLanguage: "en-US",
      audioSampleRate: 16000,
      projectPath: "/repo",
      sessionId: "claude-1",
      shareOwnerUserId: null,
      shareId: null,
    });

    await vi.waitFor(async () => {
      const raw = await AsyncStorage.getItem("aimux-settings");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw ?? "{}")).toEqual({
        theme: "light",
        agentOutputViewMode: "terminal",
        exposePreviewMode: "chat",
        desktopAppZoom: 150,
        chatRichTerminalColors: true,
        acceptedShares: [
          {
            shareId: "share_1",
            ownerUserId: "user_owner",
            projectRoot: "/repo",
            sessionId: "claude-1",
            serviceEndpoint: { host: "127.0.0.1", port: 43192 },
            acceptedAt: "2026-05-24T00:00:00.000Z",
          },
        ],
        activeShare: {
          shareId: "share_1",
          ownerUserId: "user_owner",
          projectRoot: "/repo",
          sessionId: "claude-1",
          serviceEndpoint: { host: "127.0.0.1", port: 43192 },
          acceptedAt: "2026-05-24T00:00:00.000Z",
        },
        monitor: {
          intervalSeconds: 15,
          targetKind: "project-agent",
          captureMode: "camera",
          speechToText: true,
          speechOnDeviceOnly: true,
          speechInterimResults: true,
          speechLanguage: "en-US",
          audioSampleRate: 16000,
          projectPath: "/repo",
          sessionId: "claude-1",
          shareOwnerUserId: null,
          shareId: null,
        },
        notifications: {
          enabled: true,
          channels: {
            browser: true,
            push: false,
          },
          categories: {
            agent: {
              enabled: true,
              needsInput: true,
              blocked: true,
              errors: true,
              completed: true,
              activity: false,
            },
            system: {
              enabled: false,
              relayStatus: false,
              projectHealth: false,
            },
          },
        },
      });
    });
  });
});
