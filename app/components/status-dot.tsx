import React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

// Visual status indicator used across the sidebar tree, main-panel cards, and
// service detail screen. A solid colored circle rather than the `●` text
// glyph — stays crisp at small sizes and aligns reliably with sibling text.

const SIZE_CLASS: Record<"sm" | "md" | "lg", string> = {
  sm: "w-2 h-2",
  md: "w-2.5 h-2.5",
  lg: "w-3 h-3",
};

const TONE_BG: Record<string, string> = {
  running: "bg-emerald-500",
  idle: "bg-zinc-400",
  waiting: "bg-amber-500",
  exited: "bg-zinc-600",
  offline: "bg-zinc-600",
};

const TONE_PILL_BG: Record<string, string> = {
  running: "bg-emerald-500/15",
  idle: "bg-zinc-500/15",
  waiting: "bg-amber-500/15",
  exited: "bg-zinc-500/10",
  offline: "bg-zinc-500/10",
};

const TONE_PILL_TEXT: Record<string, string> = {
  running: "text-emerald-400",
  idle: "text-zinc-300",
  waiting: "text-amber-400",
  exited: "text-zinc-400",
  offline: "text-zinc-400",
};

export function StatusDot({ status, size = "sm" }: { status: string; size?: "sm" | "md" | "lg" }) {
  const bg = TONE_BG[status] ?? "bg-zinc-500";
  return <View className={cn("rounded-full", SIZE_CLASS[size], bg)} />;
}

export function StatusPill({ status }: { status: string }) {
  const bg = TONE_PILL_BG[status] ?? "bg-zinc-500/10";
  const text = TONE_PILL_TEXT[status] ?? "text-zinc-400";
  return (
    <View className={cn("px-1.5 py-0.5 rounded", bg)}>
      <Text className={cn("text-[10px] font-medium uppercase tracking-wide", text)}>{status}</Text>
    </View>
  );
}
