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
