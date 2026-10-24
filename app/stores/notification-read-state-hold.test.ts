import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { projectStateKey } from "@/lib/project-key";

// A real async storage, because the hold being tested only exists while a read
// is in flight and the SSR-safe fallback answers synchronously. The rest of
// `notifications.test.ts` runs against that synchronous path on purpose.
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

const KEY = "aimux-notification-read-state";
const PROJECT = projectStateKey({ machineId: "mbp", path: "/repo/aimux" });

beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  await AsyncStorage.clear();
});

// The marks are read, pruned and stored back whole, so a mark that lands
// before the stored map does would replace up to three days of them with the
// one notification just seen. A cold-start notification tap is exactly that:
// `NativeNotificationRouter` asks for the tapped notification on mount and
// marks it immediately.
describe("marking a notification read before the stored marks arrive", () => {
  it("does not throw away the marks already on disk", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ readAtByKey: { [`${PROJECT}\u0000earlier`]: new Date().toISOString() } }),
    );
    vi.resetModules();
    const notifications = await import("./notifications");
    const store = createStore();

    store.set(notifications.markNotificationRecordsReadLocalAtom, {
      projectStateKey: PROJECT,
      ids: ["tapped-just-now"],
    });

    const stored = JSON.parse((await AsyncStorage.getItem(KEY)) ?? "{}");
    expect(
      Object.keys(stored.readAtByKey ?? {}),
      "the mark from before this launch is still there",
    ).toEqual([`${PROJECT}\u0000earlier`]);
  });

  // And once they have arrived, marking works and keeps both.
  it("keeps both once the stored marks have arrived", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ readAtByKey: { [`${PROJECT}\u0000earlier`]: new Date().toISOString() } }),
    );
    vi.resetModules();
    const notifications = await import("./notifications");
    const store = createStore();
    const unsubscribe = store.sub(notifications.notificationLocalReadStateAtom, () => {});
    await vi.waitFor(() => {
      expect(
        Object.keys(store.get(notifications.notificationLocalReadStateAtom).readAtByKey),
      ).toHaveLength(1);
    });

    store.set(notifications.markNotificationRecordsReadLocalAtom, {
      projectStateKey: PROJECT,
      ids: ["tapped-just-now"],
    });

    expect(
      Object.keys(store.get(notifications.notificationLocalReadStateAtom).readAtByKey).sort(),
    ).toEqual([`${PROJECT}\u0000earlier`, `${PROJECT}\u0000tapped-just-now`].sort());
    unsubscribe();
  });
});
