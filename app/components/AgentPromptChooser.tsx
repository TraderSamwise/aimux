import { Pressable, View } from "react-native";

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
  onChoose,
}: {
  selection: LivePaneSelection;
  /** The option currently being sent, so the row can say so. */
  busyLabel: string | null;
  onChoose: (option: { label: string; number?: number }) => void;
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
            onPress={() => onChoose({ label: option.label, number: option.number })}
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
      {selection.footer ? (
        <Text className="px-1 text-[11px] text-muted-foreground" numberOfLines={1}>
          {selection.footer}
        </Text>
      ) : null}
    </View>
  );
}
