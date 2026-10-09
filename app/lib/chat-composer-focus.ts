/**
 * A request to put the chat composer's keyboard back, which outlives the
 * composer that was focused when it was taken away.
 *
 * Tapping an agent in the sidebar closes the drawer AND navigates, so the
 * screen holding the composer is unmounting at the moment the keyboard should
 * return. A direct call would focus the outgoing composer and the new chat
 * would land with no keyboard, so the request waits for whichever composer
 * registers next.
 */
type ChatComposerFocus = () => void;

let registered: ChatComposerFocus | null = null;
let requestedAt: number | null = null;

/// A restore is the continuation of the tap that closed the drawer. Past this
/// it is a keyboard the user cannot explain -- navigate to a screen with no
/// composer, come back minutes later, and an unbounded request would fire.
export const CHAT_COMPOSER_FOCUS_REQUEST_TTL_MS = 1_500;

export function requestChatComposerFocus(now = Date.now()): boolean {
  requestedAt = now;
  return deliverChatComposerFocus(now);
}

export function registerChatComposerFocus(focus: ChatComposerFocus, now = Date.now()): () => void {
  registered = focus;
  deliverChatComposerFocus(now);
  return () => {
    if (registered === focus) registered = null;
  };
}

/// True only when a composer was actually focused, so the caller can tell a
/// delivered restore from one that had nobody to deliver to.
export function deliverChatComposerFocus(now = Date.now()): boolean {
  if (requestedAt === null || !registered) return false;
  if (now - requestedAt > CHAT_COMPOSER_FOCUS_REQUEST_TTL_MS) {
    requestedAt = null;
    return false;
  }
  requestedAt = null;
  registered();
  return true;
}

export function clearChatComposerFocusRequest(): void {
  requestedAt = null;
}
