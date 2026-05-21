import React from "react";
import { View } from "react-native";
import { useAtomValue } from "jotai";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import type { RelayStatus } from "@/lib/relay-transport";

// Compact relay connection pill for the TopBar. Hidden entirely when no relay
// is configured (local-only deployments). Shows a colored dot + label tied to
// the live RelayTransport status.

const STATUS_META: Record<RelayStatus, { label: string; dot: string; text: string }> = {
  connected: { label: "Remote", dot: "bg-emerald-500", text: "text-emerald-400" },
  connecting: { label: "Connecting", dot: "bg-amber-500", text: "text-amber-400" },
  daemon_offline: { label: "Host offline", dot: "bg-zinc-500", text: "text-zinc-400" },
  disconnected: { label: "Offline", dot: "bg-zinc-600", text: "text-zinc-500" },
};

export function RelayIndicator() {
  const configured = useAtomValue(relayConfiguredAtom);
  const status = useAtomValue(relayStatusAtom);
  if (!configured) return null;

  const meta = STATUS_META[status];

  return (
    <View className="flex-row items-center px-2 py-1 rounded-md bg-secondary border border-border">
      <View className={cn("w-1.5 h-1.5 rounded-full mr-1.5", meta.dot)} />
      <Text className={cn("text-[11px] font-medium", meta.text)}>{meta.label}</Text>
    </View>
  );
}
