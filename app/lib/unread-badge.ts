/**
 * How an unread count is written, in one place.
 *
 * Four surfaces render this number: this badge, the TUI dashboard row's badge,
 * the project service's `compactHint`, and the statusline's top line. The three
 * on the Rust side now share `capped_count_label`; this is the client half, and
 * `unread-badge.test.ts` pins it to the same strings that
 * `agent_unread_across_surfaces.rs` asserts.
 *
 * The cap has to say it is a cap. `compactHint` used to build its text with
 * `min(99)`, so 150 unread read "99 unread" -- a wrong number rather than a
 * marked one -- while this badge already said "99+".
 */
export const UNREAD_BADGE_CAP = 99;

/** The badge's text, or null when there is no badge to draw. */
export function unreadBadgeLabel(count: number | undefined): string | null {
  if (!count || count < 1) return null;
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(count);
}
