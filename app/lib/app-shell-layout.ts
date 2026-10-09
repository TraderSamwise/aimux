export const PERSISTENT_SIDEBAR_MIN_WIDTH = 900;

export type SidebarPresentation = "drawer" | "persistent";

export function getSidebarPresentation(width: number): SidebarPresentation {
  return width >= PERSISTENT_SIDEBAR_MIN_WIDTH ? "persistent" : "drawer";
}

export function canUsePersistentSidebar(width: number): boolean {
  return getSidebarPresentation(width) === "persistent";
}

export function shouldDismissSidebarOnNavigate(width: number): boolean {
  return getSidebarPresentation(width) === "drawer";
}

/// The drawer slides over the chat, so a keyboard left up from the composer
/// covers the sidebar's own rows. Only on open: once it closes the composer
/// is already blurred, and re-raising the keyboard under a finger is worse.
export function shouldDismissKeyboardForSidebar(state: {
  open: boolean;
  presentation: SidebarPresentation;
}): boolean {
  return state.presentation === "drawer" && state.open;
}
