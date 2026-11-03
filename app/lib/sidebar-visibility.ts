/**
 * Whether the sidebar should be open, decided in one place.
 *
 * Narrowing the window hid the sidebar and widening it never brought it
 * back: the shell ran `if (!persistent) setSidebarOpen(false)` and had no
 * branch for the other direction, so the window could only ever lose it.
 *
 * The other half is that a reader who hides the sidebar deliberately must
 * keep it hidden when the window changes size. Without somewhere to record
 * that, restoring on expand would fight the button. So the question is not
 * "is it open" but "is it open for this width, given what the reader asked
 * for" -- one answer, from both facts.
 */
export function sidebarOpenForPresentation({
  persistent,
  forcedHidden,
}: {
  persistent: boolean;
  forcedHidden: boolean;
}): boolean {
  // A narrow window has no room for it whatever the reader asked for; the
  // drawer is how they get it back.
  if (!persistent) return false;
  return !forcedHidden;
}
