import type { DesktopSession } from "@/lib/desktop-state";

/**
 * The chips an agent's row says about it, as the project service decided them.
 *
 * The order, the labels and the tones are not this surface's call -- they are
 * published on `semantic.presentation.rowChips` by `agent_row_chips` in the
 * project service, and the terminal dashboard renders the same list. What is
 * this surface's call is how many fit.
 */
export interface RowChip {
  kind: string;
  label: string;
  tone: RowChipTone;
}

export type RowChipTone = "attention" | "danger" | "work" | "info" | "muted";

/** How many chips a row shows before it says there are more. */
export const ROW_CHIP_BUDGET = 2;

/** One for a row that has already given its width to the name. */
export const NARROW_ROW_CHIP_BUDGET = 1;

/**
 * Whether the service published a list at all, however many entries survive
 * reading it.
 *
 * Keyed on presence, not on length, because the terminal reader is: a list
 * whose every entry is malformed would otherwise leave the app rendering its
 * version-skew fallback while the terminal rendered nothing.
 */
export function hasPublishedRowChips(session: Pick<DesktopSession, "semantic">): boolean {
  return Array.isArray(session.semantic?.presentation?.rowChips);
}

export function rowChipsOf(session: Pick<DesktopSession, "semantic">): RowChip[] {
  const chips = session.semantic?.presentation?.rowChips;
  if (!Array.isArray(chips)) return [];
  // Each field checked, because a build that publishes a different shape
  // should cost a row its chips rather than its render.
  return chips.filter(
    (chip): chip is RowChip =>
      typeof chip?.kind === "string" &&
      typeof chip?.label === "string" &&
      typeof chip?.tone === "string",
  );
}

/**
 * The chips a row with room for `budget` shows, and whether there were more.
 *
 * Filters the published order; it never reorders it. Dropping the rest in
 * silence is the part that would be wrong, so `more` is what the row renders
 * its overflow mark from.
 */
export function visibleRowChips(
  chips: readonly RowChip[],
  budget: number,
): { visible: RowChip[]; more: boolean } {
  const room = Math.max(0, budget);
  if (chips.length <= room) return { visible: [...chips], more: false };
  return { visible: chips.slice(0, room), more: true };
}

/** How this client paints a tone the service named. */
export function rowChipColors(tone: RowChipTone): { border: string; text: string } {
  switch (tone) {
    case "attention":
      return { border: "#e0b341", text: "#e0b341" };
    case "danger":
      return { border: "#e05f5f", text: "#e05f5f" };
    case "work":
      return { border: "#78dce8", text: "#78dce8" };
    case "info":
      return { border: "#8f9bd4", text: "#a7b2e6" };
    default:
      return { border: "#3b4150", text: "#9aa0ad" };
  }
}
