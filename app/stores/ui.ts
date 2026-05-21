import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createSsrSafeJsonStorage } from "@/lib/jotai-storage";

export type ThemePreference = "system" | "light" | "dark";

// Persisted theme preference. Default is "dark" per Task 5.
export const themePreferenceAtom = atomWithStorage<ThemePreference>(
  "aimux-theme",
  "dark",
  createSsrSafeJsonStorage<ThemePreference>(),
  { getOnInit: true },
);

// Ephemeral — not persisted across reloads.
export const sidebarOpenAtom = atom<boolean>(true);

// When true, the sidebar shows the project picker even though a project is selected.
// Reset to false by the picker click handler after the user picks a project, and by
// the sidebar via useEffect when the selected project path changes externally.
export const sidebarShowProjectPickerAtom = atom<boolean>(false);
