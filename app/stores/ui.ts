import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

// Ephemeral — not persisted across reloads.
export const sidebarOpenAtom = atom<boolean>(true);

/**
 * The reader asked for the sidebar to be hidden on a window wide enough to
 * show it.
 *
 * Separate from `sidebarOpenAtom`, which also moves when the window is too
 * narrow to hold a sidebar at all. Without the two apart, restoring on
 * expand fights the hide button: the reader hides it, resizes, and it comes
 * back. In memory on purpose, so a refresh starts over.
 */
export const sidebarForcedHiddenAtom = atom<boolean>(false);

export type SidebarMode = "dashboard" | "views";

export const sidebarModeAtom = atom<SidebarMode>("dashboard");

// When true, the sidebar shows the project picker even though a project is selected.
// Reset to false by the picker click handler after the user picks a project, and by
// the sidebar via useEffect when the selected project path changes externally.
export const sidebarShowProjectPickerAtom = atom<boolean>(false);

// Ephemeral — the project picker defaults to active projects on every app load.
export const sidebarProjectPickerShowAllAtom = atom<boolean>(false);

export const chatChromeVisibleAtom = atom<boolean>(true);

export const chatComposerDraftFamily = atomFamily((_key: string) => atom<string>(""));

export const chatComposerSendOperationFamily = atomFamily((_key: string) =>
  atom<symbol | null>(null),
);
