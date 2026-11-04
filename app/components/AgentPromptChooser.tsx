import { Pressable, View, type LayoutChangeEvent } from "react-native";

import { Text } from "@/components/ui/text";
import type { LivePaneSelection } from "@/lib/events";

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
  onGiveUpWaiting,
  onLayout,
}: {
  selection: LivePaneSelection;
  /** The option currently being sent, so the row can say so. */
  busyLabel: string | null;
  /** Why the service refused the last answer, if it did. */
  refusal: string | null;
  onChoose: (option: {
    label: string;
    number?: number;
    question?: string;
    subject?: string;
  }) => void;
  /** Release a held answer the pane never confirmed either way. */
  onGiveUpWaiting: () => void;
  /** Reported so the transcript can reserve the height this card actually takes. */
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const busy = busyLabel !== null;
  return (
    <View
      className="mb-2 gap-1.5 rounded-lg border border-border bg-muted/40 p-2"
      onLayout={onLayout}
    >
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
                // Opaque, and sent for the same reason: two prompts can ask
                // the same question over the same options and be about
                // different commands.
                subject: selection.subject,
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
        An answer is held until the pane says the chooser moved on, and a pane
        that stops answering at all — the agent exited, the stream dropped —
        would otherwise hold it forever with every row disabled. The frames
        that prove an answer cannot still be in flight clear it on their own;
        this is the escape when none of them arrives.
      */}
      {busy ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop waiting for this answer"
          onPress={onGiveUpWaiting}
          className="self-start rounded-md px-2 py-1"
        >
          <Text className="text-[11px] text-muted-foreground underline">
            Stop waiting and choose again
          </Text>
        </Pressable>
      ) : null}
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
