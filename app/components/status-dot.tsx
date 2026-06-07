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

// Restyle (Linear-style) dot used by the project view: green = running,
// amber = waiting, muted otherwise; `hollow` renders an empty ring for
// inactive/empty worktrees. Palette mirrors docs/mockups/project-view.html.
// Shape encodes entity type (mirrors the TUI): circle = agent, square =
// worktree, diamond = service. Fill encodes status (green = running, muted
// otherwise); `hollow` is the empty/inactive ring.
export function StatusDotMini({
  status,
  hollow,
  shape = "circle",
  outline,
}: {
  status?: string;
  hollow?: boolean;
  shape?: "circle" | "square" | "diamond";
  outline?: boolean;
}) {
  const cornerClass = shape === "circle" ? "rounded-full" : "rounded-[1.5px]";
  const rotateClass = shape === "diamond" ? "rotate-45" : "";

  // Outline = thick unfilled ring (used for worktrees); border color still
  // encodes status: green = running, muted = idle, faint = empty.
  if (outline) {
    const size = shape === "diamond" ? "h-[7px] w-[7px]" : "h-2 w-2";
    const borderColor = hollow
      ? "border-[#44464e]"
      : status === "running"
        ? "border-[#4ade80]"
        : status === "waiting"
          ? "border-amber-400"
          : "border-[#6b6d75]";
    return <View className={cn(size, cornerClass, rotateClass, "border-2", borderColor)} />;
  }

  const sizeClass = shape === "diamond" ? "h-[6px] w-[6px]" : "h-[7px] w-[7px]";
  if (hollow) {
    return (
      <View
        className={cn(sizeClass, cornerClass, rotateClass, "border-[1.5px] border-[#44464e]")}
      />
    );
  }
  const bg =
    status === "running" ? "bg-[#4ade80]" : status === "waiting" ? "bg-amber-400" : "bg-[#5b5d66]";
  return <View className={cn(sizeClass, cornerClass, rotateClass, bg)} />;
}

// Small monospace type marker, e.g. "service", mirroring the TUI's [service] tag.
export function TypeTag({ label }: { label: string }) {
  return (
    <Text className="shrink-0 rounded border border-[#2a2b31] bg-[#1f2025] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[#787a83]">
      {label}
    </Text>
  );
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
