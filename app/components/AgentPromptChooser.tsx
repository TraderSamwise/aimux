import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import type { LivePaneSelection, LivePaneState } from "@/lib/events";

/**
 * The chooser the agent is waiting on, rendered as real controls.
 *
 * It sits above the composer rather than replacing it, because the composer is
 * still live while a chooser is up: every one of these questions can also be
 * answered in words, and some of the options ("Tell Claude what to change")
 * exist precisely to be followed by typing.
 *
 * The options come from the project service, already in the order the pane
 * drew them, and are rendered as given. A client that re-sorted or relabelled
 * them would be offering a different question than the one on screen.
 */
export function AgentPromptChooser({
  selection,
  busyLabel,
  refusal,
  onChoose,
}: {
  selection: LivePaneSelection;
  /** The option currently being sent, so the row can say so. */
  busyLabel: string | null;
  /** Why the service refused the last answer, if it did. */
  refusal: string | null;
  onChoose: (option: { label: string; number?: number; question?: string }) => void;
}) {
  const busy = busyLabel !== null;
  return (
    <View className="mb-2 gap-1.5 rounded-lg border border-border bg-muted/40 p-2">
      {selection.question ? (
        <Text className="px-1 text-[13px] font-medium text-foreground">{selection.question}</Text>
      ) : null}
      {selection.options.map((option, index) => {
        const sending = busyLabel === option.label;
        return (
          <Pressable
            // The label is the identity here, as it is in the request, but a
            // chooser may repeat one across rows, so the row index keeps the
            // keys unique without making position the identity.
            key={`${index}-${option.label}`}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ disabled: busy, selected: option.selected }}
            disabled={busy}
            onPress={() =>
              onChoose({
                label: option.label,
                number: option.number,
                // Sent with the answer so the service can refuse it if the
                // pane is asking something else by the time it looks. The
                // label alone does not say which question this was.
                question: selection.question,
              })
            }
            className={`flex-row items-center gap-2 rounded-md border px-2 py-2 ${
              option.selected ? "border-primary bg-background" : "border-border bg-background"
            } ${busy && !sending ? "opacity-50" : ""}`}
          >
            {option.number === undefined ? null : (
              <Text className="text-[12px] tabular-nums text-muted-foreground">
                {option.number}
              </Text>
            )}
            <Text className="min-w-0 flex-1 text-[13px] text-foreground">{option.label}</Text>
            {sending ? <Text className="text-[11px] text-muted-foreground">sending…</Text> : null}
          </Pressable>
        );
      })}
      {/*
        Inside the card, not in the composer's shared error line. The refusal
        names what the pane is offering instead, and that slot is cleared by
        the next keystroke — so the one message explaining why the buttons did
        not work vanished the moment the user reached for the composer.
      */}
      {refusal ? (
        <Text className="px-1 text-[11px] text-destructive" accessibilityRole="alert">
          {refusal}
        </Text>
      ) : null}
      {selection.footer ? (
        <Text className="px-1 text-[11px] text-muted-foreground" numberOfLines={1}>
          {selection.footer}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Whether the pane is waiting on something this view cannot render.
 *
 * An absent `selection` is three different facts, and only the rest of
 * `paneState` separates them: no chooser at all; a service too old to project
 * one; or a chooser the reader could not make sense of. The last is real — the
 * reader reports nothing when it can see fewer than two options — and
 * `promptVisible` is what tells them apart, because it answers a different
 * question (is the composer idle and ready for words) and the service
 * documents the two as mutually exclusive. A pane with no chooser and no idle
 * composer, that is not erroring or interrupted, is waiting on something that
 * is not a text field.
 */
export function paneIsWaitingOnAnUnreadablePrompt(paneState: LivePaneState | undefined): boolean {
  if (paneState === undefined) return false;
  if (paneState.selection !== undefined) return false;
  return (
    !paneState.promptVisible &&
    !paneState.errorVisible &&
    !paneState.interruptedVisible &&
    !paneState.updatePromptVisible
  );
}

/**
 * Said out loud rather than left as a composer standing in front of a prompt.
 *
 * The trust prompt's default row is "No, exit", so a pane left in this state
 * with no explanation is one whose default answer quits the agent.
 */
export function UnreadablePromptNotice() {
  return (
    <View className="mb-2 rounded-lg border border-border bg-muted/40 p-2">
      <Text className="px-1 text-[12px] text-muted-foreground">
        This agent is waiting on a prompt this view cannot read. Answer it in the terminal, or type
        the option.
      </Text>
    </View>
  );
}
