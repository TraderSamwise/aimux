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

// Every writer here reads the list and stores a whole new one back, so each
// one has to wait for the stored list to arrive. Mounting is what the app does
// through `useAtomValue`, and the read lands a tick later.
async function storeWithEventsLoaded() {
  const store = createStore();
  const unsubscribe = store.sub(securityModule.securityEventsAtom, () => {});
  await vi.waitFor(() => {
    expect(AsyncStorage.getItem).toHaveBeenCalledWith("aimux-security-events");
  });
  await Promise.resolve();
  return { store, unsubscribe };
}

describe("security store", () => {
  // The inbox is read, changed and stored back whole, so a write that lands
  // before the stored list does would replace it with a list built on an
  // empty one. The relay can report an event at launch, so this is reachable
  // without anybody touching the app.
  it("does not replace the stored inbox with a write that beat the read", async () => {
    await AsyncStorage.setItem(
      "aimux-security-events",
      JSON.stringify([
        {
          id: "sec-old",
          kind: "new_client_detected",
          title: "Earlier event",
          body: "from before this launch",
          createdAt: "2026-05-23T00:00:00.000Z",
          receivedAt: "2026-05-23T00:00:00.000Z",
        },
      ]),
    );
    const store = createStore();

    store.set(securityModule.addSecurityEventAtom, {
      id: "sec-new",
      kind: "new_client_detected",
      title: "Arrived before the read",
      body: "Safari from SG",
      createdAt: "2026-05-24T00:00:00.000Z",
    });

    const raw = await AsyncStorage.getItem("aimux-security-events");
    expect(
      JSON.parse(raw ?? "[]").map((event: { id: string }) => event.id),
      "the earlier event is still the only thing stored",
    ).toEqual(["sec-old"]);
  });

  it("tracks unread security events and persists them", async () => {
    const { store, unsubscribe } = await storeWithEventsLoaded();

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
    unsubscribe();
  });
});
