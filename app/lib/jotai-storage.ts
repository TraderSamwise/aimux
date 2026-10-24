import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom, type Atom, type WritableAtom } from "jotai";
import { createJSONStorage, unwrap } from "jotai/utils";

// SSR-safe no-op storage for server-side rendering (web static export).
// AsyncStorage's web shim touches `window` lazily, which crashes in Node.
const noopStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function isServer(): boolean {
  return typeof window === "undefined";
}

export function createSsrSafeJsonStorage<T>() {
  return createJSONStorage<T>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (isServer() ? noopStorage : AsyncStorage) as any,
  );
}

export function createSsrSafeMergingJsonStorage<T extends object>(defaults: T) {
  const base = createSsrSafeJsonStorage<T>();
  return {
    ...base,
    getItem: async (key: string, initialValue: T) => {
      if (isServer()) return initialValue;
      const stored = await base.getItem(key, initialValue);
      return { ...defaults, ...stored };
    },
  };
}

/// `unwrap` memoizes on BOTH the atom and the fallback, so this is a module
/// constant rather than an inline arrow: the helpers below then share one
/// derived atom -- one read of the storage, one set of caches -- for an atom
/// they are both given.
const keepPreviousValue = (previous?: unknown) => previous;

/**
 * What happened to a persisted atom's read, as three answers rather than two.
 *
 * "nothing stored", "not read yet" and "could not read" are different facts
 * and a caller that collapses them acts on the wrong one. The distinction is
 * not academic: adopting a default because the read has not landed WRITES
 * that default over the stored value, so a read reported as finished when it
 * actually failed destroys what it failed to read.
 */
export type StorageReadState = "unread" | "read" | "failed";

const reportedStorageFailures = new Set<unknown>();

/**
 * The last value each persisted atom's storage actually returned.
 *
 * `atomWithStorage` re-reads on every mount, and `unwrap` keeps no previous
 * value across a rejection -- so a remount whose read fails after an earlier
 * one SUCCEEDED would otherwise un-answer a question already answered: the
 * project the user is looking at reverts to none, and every recording that
 * waits on the read is refused for the rest of the session. A value that has
 * been read once is still the best answer available, so it is kept.
 *
 * Keyed by the atom, so it is per-process rather than per-store, and it only
 * ever caches what storage itself returned -- the same shape as memoisation.
 */
const lastAnsweredRead = new WeakMap<Atom<unknown>, unknown>();

/// Once per distinct fault. A read can re-run, and a warning per evaluation
/// would bury the first one.
function reportStorageReadFailure(error: unknown): void {
  if (reportedStorageFailures.has(error)) return;
  reportedStorageFailures.add(error);
  console.warn("[aimux] reading persisted state failed", error);
}

/**
 * Whether a persisted atom's stored value has come back, and how.
 *
 * Latched once a read has ANSWERED. `atomWithStorage` reads twice -- once
 * eagerly for `getOnInit`, again on every mount -- and `unwrap`'s default
 * fallback reports `undefined` a second time for the second promise, so an
 * unlatched signal un-answers a question that had already been answered, and
 * whoever was waiting on it starts waiting again.
 *
 * Latched in the other direction too: a read that fails AFTER one succeeded
 * still reports "read", and the value stays what was read. Un-answering there
 * would make the project the user is looking at vanish mid-session and would
 * refuse every held write for the rest of it.
 *
 * A re-read after a read that only ever FAILED is not latched, and should not
 * be: a fresh read really is in flight again, and it reports "unread" until
 * that read settles -- which it does, so nothing waits forever.
 *
 * The stored value must never itself be `undefined`, which is how `unwrap`
 * spells a read still in flight; the `Value` bound on {@link storedValueAtom}
 * is what keeps callers out of that trap.
 */
export function storageReadStateAtom(stored: Atom<unknown>): Atom<StorageReadState> {
  const resolved = unwrap(stored, keepPreviousValue);
  return atom((get) => {
    try {
      const value = get(resolved);
      if (value === undefined) return "unread";
      lastAnsweredRead.set(stored, value);
      return "read";
    } catch (error) {
      // `unwrap` rethrows a rejected read on every evaluation.
      reportStorageReadFailure(error);
      // A read that failed AFTER one succeeded has not un-answered anything.
      return lastAnsweredRead.has(stored) ? "read" : "failed";
    }
  });
}

/**
 * A persisted atom's value, once storage has answered.
 *
 * `atomWithStorage` over an async storage puts the READ ITSELF in the atom and
 * never replaces it: jotai does not unwrap a promise a plain atom happens to
 * hold, and `onMount` sets another promise. So every reader of the storage
 * atom sees a `Promise`, forever, and a reader that guards with
 * `typeof stored === "string"` quietly reads every launch as "nothing stored".
 * That is how a value can be written to disk faithfully and never once be read
 * back -- it was only ever observed when something wrote it again in the same
 * session.
 *
 * `whileUnread` is what to answer before storage has spoken, and after a read
 * that failed. It is NOT the same answer as a read that came back empty:
 * {@link storageReadStateAtom} tells all three apart, and a caller that would
 * PERSIST the answer has to consult it rather than this.
 *
 * `Value` may not include `undefined`: that is how `unwrap` spells a read in
 * flight, so a stored `undefined` would read as unread forever and any gate
 * waiting on it would never open.
 */
export function storedValueAtom<Value extends NonNullable<unknown> | null>(
  stored: Atom<Value | Promise<Value>>,
  whileUnread: Value,
): Atom<Value> {
  const key = stored as Atom<unknown>;
  const resolved = unwrap(key, keepPreviousValue);
  return atom((get) => {
    let value: unknown;
    try {
      value = get(resolved);
    } catch {
      // Reported by `storageReadStateAtom`; rethrowing here would take the
      // screen down over a storage fault. A value read earlier still stands:
      // losing it would make the project the user is looking at vanish.
      const answered = lastAnsweredRead.get(key);
      return answered === undefined ? whileUnread : (answered as Value);
    }
    if (value !== undefined) lastAnsweredRead.set(key, value);
    return value === undefined ? whileUnread : (value as Value);
  });
}

/**
 * A persisted atom's value, with writes held until it has been read.
 *
 * Nearly every write to a persisted atom is a read-modify-write: take the
 * current value, change one entry, store the whole thing back. Before the read
 * lands the caller reads a FALLBACK instead, so what it stores back is the
 * fallback plus its one change -- three days of notification read marks, a
 * hundred security events, every other setting, replaced by a single entry.
 * The write succeeds, the read state flips to answered, and nothing ever
 * corrects it. It is silent, and it is permanent.
 *
 * So the write waits for the read it is modifying. One issued earlier is
 * dropped, which costs that one change; persisting it costs everything else.
 * A read that FAILED is refused for the same reason: the stored value is
 * unknown, and a change merged onto a guess destroys what could not be read.
 *
 * This is for a value that is MODIFIED. A write that replaces the value
 * outright with something the caller already has -- the project the user just
 * picked -- loses nothing by landing early and must not be held up.
 */
export function readBeforeWriteAtom<Value extends NonNullable<unknown> | null>(
  stored: WritableAtom<Value | Promise<Value>, [Value], unknown>,
  whileUnread: Value,
): WritableAtom<Value, [Value | ((current: Value) => Value)], void> {
  const readState = storageReadStateAtom(stored as Atom<unknown>);
  const value = storedValueAtom(stored, whileUnread);
  return atom(
    (get) => get(value),
    (get, set, update: Value | ((current: Value) => Value)) => {
      if (get(readState) !== "read") return;
      const next =
        typeof update === "function" ? (update as (current: Value) => Value)(get(value)) : update;
      set(stored, next);
    },
  );
}
