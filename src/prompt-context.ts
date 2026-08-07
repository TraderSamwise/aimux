/**
 * Context the service holds on a session's behalf and attaches to every prompt.
 *
 * A remote client — a browser sitting on a page, typically — tells aimux what
 * the person is currently looking at. That fact is held here, mutable, and
 * prepended to each message they send until they clear it. The point is that
 * "every message carries it" is an invariant of the service rather than a
 * discipline each client has to remember, and the surface that knows the
 * context need not be the surface that sends the message.
 *
 * Deliberately in memory and deliberately not `SessionContextMetadata` (which
 * is cwd/worktree/branch, for the UI). This is prompt text, it is ephemeral,
 * and a restart losing it is the correct outcome: an empty context is the safe
 * state, and one persisted to disk would still be steering prompts a week
 * later.
 */

/**
 * A ceiling, not a budget. Context is a sentence or two about a page; anything
 * approaching this is a client shipping its whole state and should be told so
 * rather than quietly having a prompt inflated on its behalf.
 */
export const PROMPT_CONTEXT_MAX_BYTES = 4096;

/**
 * The backstop for a client that never clears. A closed tab and a crashed page
 * both look like silence from here, and silence must not leave a context
 * steering every message for the life of the process.
 */
export const PROMPT_CONTEXT_TTL_MS = 30 * 60 * 1000;

export interface PromptContextEntry {
  text: string;
  updatedAt: number;
  expiresAt: number;
}

/**
 * The delimiters, and the only place they are written.
 *
 * Neutralized inside a context rather than merely escaped, because there is no
 * escaping convention the agent reads — it sees one flat line of text, and the
 * closing marker means exactly what it looks like.
 */
const CONTEXT_OPEN = "[aimux context]";
const CONTEXT_CLOSE = "[/aimux context]";
/**
 * Loose on purpose: internal spacing varies once whitespace is collapsed, and
 * a marker that only matches one exact spelling is a marker with a bypass.
 */
const DELIMITER_PATTERN = /\[\s*\/?\s*aimux\s+context\s*\]/gi;
/**
 * Invisible to a reader, not to a model that will happily read a delimiter
 * through them. Written as escapes because the literal characters are exactly
 * as unreadable in this file as they are in an attack.
 */
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Whitespace runs become single spaces, here rather than at the tmux layer.
 *
 * `normalizeSubmittedPrompt` already collapses newlines on submit, so a
 * multi-line context would be flattened anyway — but flattened by something
 * three layers away, at a point where the delimiters have already been placed.
 * Doing it at the door means what is stored is what is sent.
 *
 * The delimiters are stripped from the context itself in the same pass. A
 * context carrying its own closing marker would otherwise end the block early
 * and leave whatever followed sitting where the person's own words go — text
 * from whoever holds the client, read by the agent as the operator's
 * instruction. That is the whole attack, and it costs one replace to close.
 */
export function normalizePromptContext(text: string): string {
  let stripped = text.replace(ZERO_WIDTH_PATTERN, "");
  // To a fixed point, because a single pass is not one. Removing the inner
  // marker from `[/aimux [/aimux context] context]` leaves the outer fragments
  // adjacent, and collapsing the gap between them rebuilds a working closer out
  // of the wreckage — so one replace hands back exactly what it was meant to
  // remove. Each pass strictly shortens the string, so this terminates.
  for (;;) {
    const next = stripped.replace(DELIMITER_PATTERN, " ");
    if (next === stripped) break;
    stripped = next;
  }
  return stripped.replace(/\s+/g, " ").trim();
}

/** Bytes, not characters: the cap has to mean the same thing for any alphabet. */
export function promptContextByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The message as the agent will read it.
 *
 * Context leads and the person's own words land last, which is the order that
 * keeps an instruction from being buried under the state it refers to. The
 * delimiters survive newline flattening because they are on one line by
 * construction.
 */
export function composeWithPromptContext(text: string, context: string | null): string {
  if (!context) return text;
  return `${CONTEXT_OPEN} ${context} ${CONTEXT_CLOSE} ${text}`;
}

export class PromptContextStore {
  private readonly entries = new Map<string, PromptContextEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PROMPT_CONTEXT_TTL_MS,
  ) {}

  /** Replace wholesale. Empty text clears, so a client needs one call, not two. */
  set(sessionId: string, text: string): PromptContextEntry | null {
    // Swept here because `get` only ever expires the key it was asked for, and
    // a context set for a session nobody reads again would otherwise sit in the
    // map for the life of the process.
    this.pruneExpired();
    const normalized = normalizePromptContext(text);
    if (!normalized) {
      this.entries.delete(sessionId);
      return null;
    }
    const updatedAt = this.now();
    const entry: PromptContextEntry = {
      text: normalized,
      updatedAt,
      expiresAt: updatedAt + this.ttlMs,
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  /** Expiry is checked on read, so a dead context cannot be attached to anything. */
  get(sessionId: string): PromptContextEntry | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(sessionId);
      return null;
    }
    return entry;
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  clearAll(): void {
    this.entries.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(sessionId);
    }
  }
}
