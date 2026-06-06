import { atom } from "jotai";

// Ephemeral — not persisted across reloads.
export const sidebarOpenAtom = atom<boolean>(true);

export type SidebarMode = "dashboard" | "views";

export const sidebarModeAtom = atom<SidebarMode>("dashboard");

// When true, the sidebar shows the project picker even though a project is selected.
// Reset to false by the picker click handler after the user picks a project, and by
// the sidebar via useEffect when the selected project path changes externally.
export const sidebarShowProjectPickerAtom = atom<boolean>(false);
