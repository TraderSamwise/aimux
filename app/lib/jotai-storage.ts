import AsyncStorage from "@react-native-async-storage/async-storage";
import { createJSONStorage } from "jotai/utils";

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
