/**
 * The shell a chat pane's placeholder card sits in, for both panes.
 *
 * In split mode the transcript and the terminal each show a loading card, and
 * they were centred differently: the transcript's shell carried `flex-1` and
 * the terminal's did not. Both panes scroll with `flexGrow: 1` and
 * `justifyContent: "flex-end"`, so the shell without `flex-1` stayed
 * content-height and was pushed to the BOTTOM of its pane, while the other
 * grew to fill and centred inside itself. Two cards, two heights, no shared
 * line -- which read as messy because it was.
 *
 * `flex-1` is the whole point of this constant: it is what gives
 * `justify-center` a box to centre within. A pane placeholder that drops it
 * does not centre, it sinks.
 */
export const CHAT_PANE_PLACEHOLDER_SHELL = "flex-1 items-center justify-center px-4 py-10";
