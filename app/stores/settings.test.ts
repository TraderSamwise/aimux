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
      chatTerminalSplit: false,
      activeShare: null,
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
    expect(store.get(settingsModule.chatTerminalSplitAtom)).toBe(false);
    expect(store.get(settingsModule.activeSharedSessionAtom)).toBeNull();
    expect(store.get(settingsModule.notificationSettingsAtom).enabled).toBe(false);

    store.set(settingsModule.chatTerminalSplitAtom, true);
    store.set(settingsModule.notificationSettingsAtom, {
      ...store.get(settingsModule.notificationSettingsAtom),
      enabled: true,
    });

    expect(store.get(settingsModule.chatTerminalSplitAtom)).toBe(true);
    expect(store.get(settingsModule.settingsAtom).chatTerminalSplit).toBe(true);
    expect(store.get(settingsModule.settingsAtom).notifications.enabled).toBe(true);
  });

  it("normalizes older persisted settings without notification keys", () => {
    expect(
      settingsModule.normalizeAppSettings({
        theme: "light",
        chatTerminalSplit: true,
      } as import("./settings").AppSettings),
    ).toEqual({
      ...settingsModule.defaultSettings,
      theme: "light",
      chatTerminalSplit: true,
      activeShare: null,
    });
  });

  it("persists focused atom writes to aimux-settings", async () => {
    const store = createStore();

    store.set(settingsModule.themePreferenceAtom, "light");
    store.set(settingsModule.chatTerminalSplitAtom, true);
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

    await vi.waitFor(async () => {
      const raw = await AsyncStorage.getItem("aimux-settings");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw ?? "{}")).toEqual({
        theme: "light",
        chatTerminalSplit: true,
        activeShare: {
          shareId: "share_1",
          ownerUserId: "user_owner",
          projectRoot: "/repo",
          sessionId: "claude-1",
          serviceEndpoint: { host: "127.0.0.1", port: 43192 },
          acceptedAt: "2026-05-24T00:00:00.000Z",
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
