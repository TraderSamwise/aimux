/**
 * Whether the reader wants the chat keyboard up, remembered across chats.
 *
 * Module state rather than a stored setting: a preference that survives a
 * cold start would raise the keyboard on launch, which nobody asked for. This
 * is the memory of what you were doing a moment ago, and it should die with
 * the process.
 */
let wantsKeyboardAt: number | null = null;
let programmaticBlurAt: number | null = null;

/**
 * How long "a moment ago" lasts. Every way out of a chat is a programmatic
 * dismissal, so without a bound the memory never expires: open a plan, read
 * it, come back a minute later and the keyboard returns unasked. Each carry
 * re-focuses the composer, which re-arms this, so switching chats all
 * afternoon keeps working.
 */
export const CHAT_KEYBOARD_INTENT_TTL_MS = 15_000;

/**
 * How long a programmatic blur speaks for. Every one of them is immediately
 * followed by navigation or a drawer opening, so the window only has to cover
 * the blur event itself; past that a blur is the reader's.
 */
export const PROGRAMMATIC_BLUR_WINDOW_MS = 400;

/**
 * Tapping an agent in the sidebar dismisses the keyboard and THEN navigates,
 * so the switch that should carry the keyboard forward is itself a blur. Every
 * such dismissal goes through `blurWebActiveElement`, which marks this.
 */
export function markProgrammaticComposerBlur(now = Date.now()): void {
  programmaticBlurAt = now;
}

/**
 * Focus is always the reader's. A blur only counts when nothing dismissed the
 * composer on their behalf and the screen still has navigation focus -- the
 * two ways a blur happens without anyone deciding to put the keyboard away.
 */
export function recordComposerFocusIntent(
  focused: boolean,
  {
    appVisible = true,
    hasHardwareKeyboard = false,
    now = Date.now(),
    screenFocused = true,
  }: {
    appVisible?: boolean;
    hasHardwareKeyboard?: boolean;
    now?: number;
    screenFocused?: boolean;
  } = {},
): void {
  // Above both branches: backgrounding the app blurs the composer AND hides
  // the keyboard, and a screen gone behind another is being left. Neither
  // event is the reader deciding anything, whichever way it points.
  if (!screenFocused || !appVisible) return;
  if (focused) {
    // Asked here, not when the next chat opens: by then the keyboard has been
    // dismissed, occlusion measures zero, and every device looks like it has
    // a hardware keyboard.
    wantsKeyboardAt = hasHardwareKeyboard ? null : now;
    programmaticBlurAt = null;
    return;
  }
  if (programmaticBlurAt !== null && now - programmaticBlurAt <= PROGRAMMATIC_BLUR_WINDOW_MS) {
    return;
  }
  wantsKeyboardAt = null;
}

/**
 * A keyboard that went away without the composer losing focus. Android's back
 * gesture does this, and on that path `onBlur` never fires -- so without it
 * the next chat raises a keyboard the reader has just put away.
 */
export function recordChatKeyboardHidden(
  options: { appVisible?: boolean; now?: number; screenFocused?: boolean } = {},
): void {
  recordComposerFocusIntent(false, options);
}

export type ChatKeyboardEdge = "raised" | "hidden" | null;

/**
 * Which edge a keyboard-visibility change is, or neither.
 *
 * `keyboardVisible` is a level, and an effect watching it re-runs on renders
 * that changed nothing. Deciding here rather than from a ref in the screen
 * means an inverted comparison fails a test instead of hiding in a mount.
 */
export function createChatKeyboardEdgeWatcher(initial: boolean) {
  let wasVisible = initial;
  return (visible: boolean): ChatKeyboardEdge => {
    const was = wasVisible;
    wasVisible = visible;
    if (was === visible) return null;
    return visible ? "raised" : "hidden";
  };
}

export function chatKeyboardIntent(now = Date.now()): boolean {
  if (wantsKeyboardAt === null) return false;
  return now - wantsKeyboardAt <= CHAT_KEYBOARD_INTENT_TTL_MS;
}

export function resetChatKeyboardIntent(): void {
  wantsKeyboardAt = null;
  programmaticBlurAt = null;
}

/**
 * Whether a chat that has just opened should take the keyboard with it.
 *
 * A hardware keyboard always takes it: nothing is occluded and the composer is
 * where typing goes. A soft one only when that is what the reader was doing in
 * the chat they came from -- which is why no want is recorded against one.
 */
export function shouldFocusComposerOnOpen({
  hasComposer,
  hasHardwareKeyboard,
  intent,
}: {
  hasComposer: boolean;
  hasHardwareKeyboard: boolean;
  intent: boolean;
}): boolean {
  if (!hasComposer) return false;
  return hasHardwareKeyboard || intent;
}
