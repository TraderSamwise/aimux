import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import {
  getChatPerfStats,
  subscribeChatPerfStats,
  type ChatPerfStats,
} from "@/lib/chat-perf-probe";

const MAX_ROWS = 6;

export function ChatPerfHud() {
  const [rows, setRows] = useState<ChatPerfStats[]>(() => getChatPerfStats());

  useEffect(
    () =>
      subscribeChatPerfStats(() => {
        setRows(getChatPerfStats());
      }),
    [],
  );

  return (
    <View
      pointerEvents="none"
      className="absolute right-2 top-28 z-[120] rounded-md border border-border bg-background/90 px-2 py-1"
      style={{ maxWidth: 280 }}
    >
      <Text className="font-mono text-[10px] text-muted-foreground">perf max / last / count</Text>
      {rows.slice(0, MAX_ROWS).map((row) => (
        <Text key={row.id} className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {row.id} {row.maxMs.toFixed(1)}/{row.lastMs.toFixed(1)}ms {row.count}
          {row.slowCount > 0 ? ` slow ${row.slowCount}` : ""}
          {row.detail ? ` ${row.detail}` : ""}
        </Text>
      ))}
    </View>
  );
}
