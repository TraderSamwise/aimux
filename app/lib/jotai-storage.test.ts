import { createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readBeforeWriteAtom, storageReadStateAtom, storedValueAtom } from "@/lib/jotai-storage";

// Built here rather than mocked: these helpers take an atom, so a test can
// hand them one over a storage whose reads it settles by hand. The unit
// environment's SSR-safe storage answers synchronously and would never pend.
function persisted(key: string) {
  const reads: { settle: (value: unknown) => void; fail: (error: unknown) => void }[] = [];
  const storage = {
    getItem: () => {
      const read = new Promise<unknown>((resolve, reject) => {
        reads.push({ settle: resolve, fail: reject });
      });
      read.catch(() => {});
      return read;
    },
    setItem: (_key: string, value: unknown) => {
      written.push(value);
    },
    removeItem: () => {},
  };
  const written: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stored = atomWithStorage<Record<string, string>>(key, {}, storage as any, {
    getOnInit: true,
  });
  return { stored, reads, written };
}

async function settle(
  reads: { settle: (value: unknown) => void }[],
  value: unknown,
): Promise<void> {
  for (const read of reads.splice(0, reads.length)) read.settle(value);
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readBeforeWriteAtom", () => {
  it("refuses a write before the stored value has been read, and says which", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stored, reads, written } = persisted("aimux-test-key");
    const held = readBeforeWriteAtom<Record<string, string>>(stored, {}, "aimux-test-key");
    const store = createStore();
    const unsubscribe = store.sub(held, () => {});

    const landed = store.set(held, { a: "1" });

    expect(landed, "the caller is told it did not land").toBe(false);
    expect(written, "and nothing reached storage").toEqual([]);
    // Naming the key matters: five atoms go through this helper, and a warning
    // that does not say which one was lost cannot be acted on.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("aimux-test-key"));

    await settle(reads, { b: "2" });
    expect(store.set(held, { a: "1" }), "and it lands once the read has").toBe(true);
    expect(written).toEqual([{ a: "1" }]);
    unsubscribe();
  });

  // A modifier form, because the hazard is a read-modify-write: the caller
  // must never merge onto the fallback and store that back.
  it("applies a modifier to the value that was read, not to the fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stored, reads, written } = persisted("aimux-test-key-2");
    const held = readBeforeWriteAtom<Record<string, string>>(stored, {}, "aimux-test-key-2");
    const store = createStore();
    const unsubscribe = store.sub(held, () => {});

    await settle(reads, { kept: "yes" });
    store.set(held, (current) => ({ ...current, added: "also" }));

    expect(written).toEqual([{ kept: "yes", added: "also" }]);
    unsubscribe();
  });
});

describe("storedValueAtom and storageReadStateAtom", () => {
  it("report one answer between them, from one read", async () => {
    const { stored, reads } = persisted("aimux-test-key-3");
    const value = storedValueAtom<Record<string, string>>(stored, {});
    const readState = storageReadStateAtom(stored);
    const store = createStore();
    const unsubscribe = store.sub(value, () => {});

    expect(store.get(readState)).toBe("unread");
    expect(store.get(value)).toEqual({});

    await settle(reads, { from: "storage" });

    expect(store.get(readState)).toBe("read");
    expect(store.get(value)).toEqual({ from: "storage" });
    unsubscribe();
  });
});
