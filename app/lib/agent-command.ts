/**
 * Whether an input is a command the agent parses rather than prose.
 *
 * The daemon decides this too, in `project_service/agent_input.rs`, to choose
 * whether a shared-chat message keeps its `[sender]` attribution. Both sides
 * assert `testdata/contracts/v1/agent-command-input.json`, because when each
 * owned its own answer the two could disagree and a delivered command looked
 * like a failed send.
 *
 * Here it answers a different question with the same rule: whether to expect
 * this text back in the parsed transcript. A command is consumed by the agent
 * and need not appear as a user turn, so waiting for an echo of one and then
 * blaming the connection is a false alarm about a message that arrived.
 *
 * Single line only, and the shape of the first token decides -- a command and
 * a path do not look alike. See the Rust doc comment for why each case is
 * where it is; this is a port, not a new rule.
 */

/**
 * The whitespace both sides agree on.
 *
 * The two languages disagree at the edges, and each trimming with its own
 * notion made them disagree about the same message. Rust's
 * `char::is_whitespace` is the Unicode White_Space property, which includes
 * U+0085 NEL; JavaScript's `trim` instead includes U+FEFF, which is not
 * White_Space. So `\u0085/clear` was a command to the daemon and prose here,
 * and `\ufeff/clear` the other way round -- on an answer that decides whether
 * a guest's line keeps its attribution.
 *
 * This class is the Unicode White_Space property plus U+FEFF, which is what
 * the Rust predicate is.
 */
const SHARED_WHITESPACE =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
/**
 * Splitting with the same class.
 *
 * Note for anyone simplifying this back to `/\s+/`: that is currently an
 * equivalent split, because the only character the two classes disagree on
 * which is not already rejected as a line break is U+0085. Mutating it
 * therefore proves nothing. It is written this way so the two files read as
 * the same rule, and because the Rust side's equivalent IS load-bearing --
 * `split_whitespace` there does not treat U+FEFF as a separator.
 */
const SHARED_WHITESPACE_RUN = new RegExp(`${SHARED_WHITESPACE.source}+`, "g");

/**
 * What counts as starting a new line, which a command may not do.
 *
 * `\n` and `\r` were not the whole set. A vertical tab or a form feed renders
 * as a line break, and U+2028 and U+2029 are the line and paragraph separators
 * by definition -- so `!ls\u000brm -rf /` passed the single-line test and
 * reached the agent with its sender stripped.
 */
const LINE_BREAK = /[\n\r\u000b\u000c\u0085\u2028\u2029]/;

/** Trim as the daemon trims, rather than as this language happens to. */
export function sharedWhitespaceTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && SHARED_WHITESPACE.test(text[start]!)) start += 1;
  while (end > start && SHARED_WHITESPACE.test(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

function isCommandWordStart(character: string): boolean {
  return /^[A-Za-z]$/.test(character);
}

/** One segment of a slash command's name, with nothing path-like in it. */
function isSingleCommandSegment(name: string): boolean {
  if (!name) return false;
  if (!isCommandWordStart(name[0])) return false;
  return [...name.slice(1)].every(
    (character) => /^[A-Za-z0-9]$/.test(character) || character === "-" || character === "_",
  );
}

export function looksLikeAgentCommand(text: string): boolean {
  const trimmed = sharedWhitespaceTrim(text);
  if (!trimmed) return false;
  // A sigil must not carry following paragraphs through as if they were part
  // of the command.
  if (LINE_BREAK.test(trimmed)) return false;
  const firstToken = trimmed.split(SHARED_WHITESPACE_RUN)[0] ?? "";
  const first = trimmed[0];
  const second = trimmed[1];
  if (first === "/") return isSingleCommandSegment(firstToken.slice(1));
  if (first === "!") return second !== undefined && isCommandWordStart(second);
  if (first === "$") return second !== undefined && (second === " " || isCommandWordStart(second));
  return false;
}
