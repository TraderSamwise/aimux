import React from "react";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { runtimeBrandForAgent } from "@/lib/runtime-brand";
import type { AgentDisplayInput } from "@/lib/agent-display";

/**
 * Which tool an agent is, in the width of two letters.
 *
 * The chat header has no horizontal room left -- back chevron, accent rule,
 * two lines of text, the mode toggle and an action row that already overflows
 * -- so the runtime cannot be a word there. Two letters in the runtime's own
 * colour fit where nothing else does, and the real word rides the
 * accessibility label so a screen reader says "Codex" rather than spelling it.
 *
 * Fixed width on purpose: the mark must not resize when the tool changes, or
 * the line beside it reflows every time an agent is replaced.
 */
export const RUNTIME_BRAND_MARK_WIDTH = 22;

export function RuntimeBrandMark({ agent }: { agent: AgentDisplayInput }) {
  const brand = runtimeBrandForAgent(agent);
  return (
    <View
      accessibilityLabel={brand.label}
      className="items-center justify-center rounded border px-1 py-0.5"
      style={{
        backgroundColor: brand.background,
        // `minHeight`, not `height`: Android adds font padding inside a 9pt
        // line, and every comparable chip in this app grows rather than
        // clipping. The border is not decoration -- `headerTone` is a hashed
        // hue with nothing excluded, so a green worktree rule can sit two
        // points from a green `CX`, and the edge is what keeps them apart.
        borderColor: brand.color,
        minHeight: 14,
        minWidth: RUNTIME_BRAND_MARK_WIDTH,
      }}
    >
      <Text
        style={{
          color: brand.color,
          fontSize: 9,
          fontWeight: "700",
          letterSpacing: 0.3,
          lineHeight: 11,
        }}
      >
        {brand.shortLabel}
      </Text>
    </View>
  );
}
