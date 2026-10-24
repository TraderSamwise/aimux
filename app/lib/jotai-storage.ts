import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom, type Atom } from "jotai";
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
 * Latched between "unread" and the other two. `atomWithStorage` reads twice --
 * once eagerly for `getOnInit`, again on every mount -- and `unwrap`'s default
 * fallback reports `undefined` a second time for the second promise, so an
 * unlatched signal un-answers a question that had already been answered, and
 * whoever was waiting on it starts waiting again.
 *
 * The stored value must never itself be `undefined`, which is how `unwrap`
 * spells a read still in flight; the `Value` bound on {@link storedValueAtom}
 * is what keeps callers out of that trap.
 */
export function storageReadStateAtom(stored: Atom<unknown>): Atom<StorageReadState> {
  const resolved = unwrap(stored, keepPreviousValue);
  return atom((get) => {
    try {
      return get(resolved) === undefined ? "unread" : "read";
    } catch (error) {
      // `unwrap` rethrows a rejected read on every evaluation.
      reportStorageReadFailure(error);
      return "failed";
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
  const resolved = unwrap(stored as Atom<unknown>, keepPreviousValue);
  return atom((get) => {
    let value: unknown;
    try {
      value = get(resolved);
    } catch {
      // Reported by `storageReadStateAtom`; rethrowing here would take the
      // screen down over a storage fault.
      return whileUnread;
    }
    return value === undefined ? whileUnread : (value as Value);
  });
}
