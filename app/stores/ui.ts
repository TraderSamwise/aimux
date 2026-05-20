import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom } from "jotai";
import { atomWithStorage, createJSONStorage } from "jotai/utils";

export type ThemePreference = "system" | "light" | "dark";

// SSR-safe noop storage for server-side rendering (web static export). AsyncStorage's
// web shim accesses `window` at call time which crashes in Node.
const noopStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function isServer(): boolean {
  return typeof window === "undefined";
}

const themeStorage = createJSONStorage<ThemePreference>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  () => (isServer() ? noopStorage : AsyncStorage) as any,
);

// Persisted theme preference. Default is "dark" per Task 5.
export const themePreferenceAtom = atomWithStorage<ThemePreference>(
  "aimux-theme",
  "dark",
  themeStorage,
  { getOnInit: true },
);

// Ephemeral — not persisted across reloads.
export const sidebarOpenAtom = atom<boolean>(true);
