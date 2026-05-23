import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("settings store", () => {
  it("keeps durable UI settings in one persisted settings object", () => {
    expect(settingsModule.defaultSettings).toEqual({
      theme: "dark",
      chatTerminalSplit: false,
    });
  });

  it("exposes focused atoms for individual settings", () => {
    const store = createStore();

    expect(store.get(settingsModule.themePreferenceAtom)).toBe("dark");
    expect(store.get(settingsModule.chatTerminalSplitAtom)).toBe(false);

    store.set(settingsModule.chatTerminalSplitAtom, true);

    expect(store.get(settingsModule.chatTerminalSplitAtom)).toBe(true);
    expect(store.get(settingsModule.settingsAtom).chatTerminalSplit).toBe(true);
  });

  it("persists focused atom writes to aimux-settings", async () => {
    const store = createStore();

    store.set(settingsModule.themePreferenceAtom, "light");
    store.set(settingsModule.chatTerminalSplitAtom, true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const raw = await AsyncStorage.getItem("aimux-settings");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "{}")).toEqual({
      theme: "light",
      chatTerminalSplit: true,
    });
  });
});
