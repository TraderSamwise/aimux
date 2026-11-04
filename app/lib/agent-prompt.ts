/**
 * Reading an agent's "waiting for you to choose" state out of its pane.
 *
 * Built against real captures, not inferred shapes -- see
 * `app/lib/__fixtures__/agent-prompts/`, taken from a live Claude Code agent
 * driven through tmux. Five shapes, and they differ more than they look:
 *
 * - workspace trust: a cursor and two options, NO numbers anywhere
 * - tool permission: `1./2./3.` under a diff preview
 * - AskUserQuestion: numbered, each with an indented description line, and
 *   the last option sits BELOW the box's bottom border
 * - plan approval: numbered, with no `Esc to cancel` footer at all
 * - a plain prose question: no menu, and must not render as one
 *
 * Two signals that look obvious and are wrong, both measured:
 *
 * `❯` cannot be counted. It marks the selected option, but it is also the
 * composer and every echoed past message, so the prose fixture carries THREE
 * of them while the real trust prompt carries one.
 *
 * The footer cannot be the trigger. Plan approval is a real prompt whose
 * footer is a Vim hint, so keying on `Esc to cancel` silently misses it.
 *
 * What separates them is POSITION and SELECTION. The live prompt is always
 * at the bottom, so only the tail is read; and a live chooser always marks
 * one option, so a list with nothing selected is prose that happens to be
 * numbered.
 *
 * An explicit "is the composer empty" check was written first and then
 * removed: mutation testing showed it could be deleted with every case still
 * green, because the tail window already excludes an answered prompt's
 * options and the selection rule already excludes a bare composer. Keeping it
 * would have been dead code carrying a claim it did not earn -- and worse
 * than dead, since a pane that showed a composer beside a live prompt would
 * then have been rejected.
 */

/** Rows from the bottom that can hold the active prompt. */
const PROMPT_TAIL_LINES = 40;

const CURSOR = "❯";

/**
 * CSI *and* OSC. `ansi.ts` strips only SGR, which is right for rendering
 * colour but leaves an OSC-8 hyperlink's envelope in the text -- the trust
 * fixture's "Security guide" link arrives as `]8;id=...;https://...\` wrapped
 * around the label. A parser reading that as option text would show the URL.
 */
const CSI = /\x1b\[[0-9;?:]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC_ORPHAN = /\]8;[^\\]*\\/g;

const NUMBERED_OPTION = /^(\s*)(?:❯\s*)?(\d+)\.\s+(.*)$/;
const BORDER = /^[\s─━═╌╍⎯_=]+$/;
const FOOTER = /(?:Enter to|Esc to|↑\/↓|shift\+tab to|ctrl\+[a-z] to|Tab to)\s/;

export interface AgentPromptOption {
  /** The number the agent showed, when it numbered them at all. */
  number: number | null;
  label: string;
  selected: boolean;
}

export interface AgentPrompt {
  question: string | null;
  options: AgentPromptOption[];
  /** The key hints the agent printed, when it printed any. */
  footer: string | null;
}

export function stripTerminalEscapes(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(OSC_ORPHAN, "");
}

/**
 * The prompt the pane is showing, or null when it is not asking anything.
 *
 * Null is the common case and the important one: rendering a chooser over an
 * agent that is merely working, or that asked a question in prose, is worse
 * than not having the feature.
 */
export function parseAgentPrompt(paneText: string): AgentPrompt | null {
  const lines = stripTerminalEscapes(paneText)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
  // Trailing blanks come off FIRST. `tmux capture-pane` pads the capture to
  // the pane's full height, so a prompt that fills ten rows of an 82-row
  // pane is followed by seventy empty ones -- take the last forty lines
  // without this and every one of them is blank.
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  const tail = lines.slice(Math.max(0, end - PROMPT_TAIL_LINES), end);

  const numbered = collectNumberedOptions(tail);
  const options = numbered.length >= 2 ? numbered : collectCursorOptions(tail);
  if (options.length < 2) return null;
  // Something has to be selected, or this is a list in prose rather than a
  // live chooser.
  if (!options.some((option) => option.selected)) return null;

  return {
    question: questionAbove(tail, options[0]!.label),
    options,
    footer:
      tail
        .filter((line) => FOOTER.test(line))
        .at(-1)
        ?.trim() ?? null,
  };
}

/**
 * Numbered options, in the order the agent listed them.
 *
 * Deliberately NOT stopped by a border: AskUserQuestion draws its "Chat about
 * this" option below the box, so a collector that halted at the bottom edge
 * silently dropped a real choice.
 *
 * A line indented past its option is that option's description, not another
 * option -- that is how AskUserQuestion renders them.
 */
function collectNumberedOptions(tail: readonly string[]): AgentPromptOption[] {
  const options: AgentPromptOption[] = [];
  for (const line of tail) {
    const match = NUMBERED_OPTION.exec(line);
    if (!match) continue;
    const [, , rawNumber, label] = match;
    const number = Number(rawNumber);
    // Restart on a repeated 1., so scrollback from an earlier prompt cannot
    // merge into the live one.
    if (number === 1 && options.length > 0) options.length = 0;
    options.push({
      number,
      label: label!.trim(),
      selected: line.includes(CURSOR),
    });
  }
  return options;
}

/**
 * The unnumbered shape: a cursor line and its siblings, as the workspace
 * trust prompt draws them.
 */
function collectCursorOptions(tail: readonly string[]): AgentPromptOption[] {
  const cursorAt = tail.findIndex((line) => line.trimStart().startsWith(`${CURSOR} `));
  if (cursorAt < 0) return [];
  const options: AgentPromptOption[] = [
    { number: null, label: tail[cursorAt]!.trim().slice(CURSOR.length).trim(), selected: true },
  ];
  for (const line of tail.slice(cursorAt + 1)) {
    const text = line.trim();
    if (!text || BORDER.test(line) || FOOTER.test(line)) break;
    options.push({ number: null, label: text, selected: false });
  }
  return options;
}

/** The last real sentence above the options, which is the question. */
function questionAbove(tail: readonly string[], firstOptionLabel: string): string | null {
  const firstOptionAt = tail.findIndex((line) => line.includes(firstOptionLabel));
  for (let index = firstOptionAt - 1; index >= 0; index -= 1) {
    const text = tail[index]!.trim();
    if (!text || BORDER.test(tail[index]!)) continue;
    return text;
  }
  return null;
}
