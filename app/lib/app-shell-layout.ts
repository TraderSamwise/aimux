export const PERSISTENT_SIDEBAR_MIN_WIDTH = 900;

export function canUsePersistentSidebar(width: number): boolean {
  return width >= PERSISTENT_SIDEBAR_MIN_WIDTH;
}
