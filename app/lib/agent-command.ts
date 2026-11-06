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
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A sigil must not carry following paragraphs through as if they were part
  // of the command.
  if (trimmed.includes("\n") || trimmed.includes("\r")) return false;
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const first = trimmed[0];
  const second = trimmed[1];
  if (first === "/") return isSingleCommandSegment(firstToken.slice(1));
  if (first === "!") return second !== undefined && isCommandWordStart(second);
  if (first === "$") return second !== undefined && (second === " " || isCommandWordStart(second));
  return false;
}
