/**
 * Startup interstitials: modal prompts a tool shows before its own prompt is
 * usable, which block an aimux session until somebody presses a key.
 *
 * Answered per-pane, by reading the pane and choosing a named option. Nothing
 * is written to the tool's own config, so the same tool run directly in the
 * host's terminal still shows its prompts normally.
 */

export interface StartupInterstitial {
  id: string;
  /** Every fragment must be on screen before this counts as showing. */
  when: string[];
  /**
   * Regex for the option line to choose; capture group 1 is the key to send.
   * Reading the number off the menu rather than hardcoding it means a reordered
   * menu picks the right option instead of the wrong one.
   */
  choose: string;
}

/**
 * The key that dismisses `interstitial`, or null if it is not showing or its
 * option cannot be found.
 *
 * Null means send nothing. There is deliberately no "just press Enter"
 * fallback: Codex opens its update prompt with `1. Update now` preselected, so
 * a blind Enter installs an upgrade nobody asked for.
 */
export function resolveInterstitialKey(screen: string, interstitial: StartupInterstitial): string | null {
  if (!interstitial.when.every((fragment) => screen.includes(fragment))) return null;
  const match = new RegExp(interstitial.choose, "m").exec(screen);
  return match?.[1] ?? null;
}

/** The first interstitial showing on `screen`, paired with the key to send. */
export function findStartupInterstitial(
  screen: string,
  interstitials: readonly StartupInterstitial[],
): { interstitial: StartupInterstitial; key: string } | null {
  for (const interstitial of interstitials) {
    const key = resolveInterstitialKey(screen, interstitial);
    if (key) return { interstitial, key };
  }
  return null;
}

/**
 * Answers each interstitial at most once per session.
 *
 * A dismissed prompt stays on screen for a moment while the tool redraws, so a
 * poll loop that only matched the screen would answer it several times over and
 * type the surplus keys into the agent's composer.
 *
 * Once-only rather than retry-until-gone, deliberately: if a keypress does not
 * land, a prompt waiting for a human is a far better outcome than stray input
 * arriving in a session that has since started working.
 */
export class StartupInterstitialDismisser {
  private readonly answered = new Set<string>();

  constructor(private readonly interstitials: readonly StartupInterstitial[]) {}

  /** The key to send for `screen`, or null if there is nothing new to answer. */
  next(screen: string): { interstitial: StartupInterstitial; key: string } | null {
    const pending = this.interstitials.filter((interstitial) => !this.answered.has(interstitial.id));
    const found = findStartupInterstitial(screen, pending);
    if (!found) return null;
    this.answered.add(found.interstitial.id);
    return found;
  }

  get done(): boolean {
    return this.answered.size >= this.interstitials.length;
  }
}
