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

let securityModule: typeof import("./security");

beforeAll(async () => {
  vi.stubGlobal("window", globalThis);
  securityModule = await import("./security");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("security store", () => {
  it("tracks unread security events and persists them", async () => {
    const store = createStore();

    store.set(securityModule.addSecurityEventAtom, {
      id: "sec-1",
      kind: "new_client_detected",
      title: "New remote client detected",
      body: "Safari from SG",
      createdAt: "2026-05-24T00:00:00.000Z",
    });

    expect(store.get(securityModule.securityUnreadCountAtom)).toBe(1);
    expect(store.get(securityModule.securityEventsAtom)[0].id).toBe("sec-1");

    await vi.waitFor(async () => {
      const raw = await AsyncStorage.getItem("aimux-security-events");
      expect(raw).not.toBeNull();
    });

    store.set(securityModule.markSecurityEventsReadAtom);
    expect(store.get(securityModule.securityUnreadCountAtom)).toBe(0);

    store.set(securityModule.clearSecurityEventsAtom);
    expect(store.get(securityModule.securityEventsAtom)).toEqual([]);
  });
});
