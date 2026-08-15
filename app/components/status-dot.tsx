import React from "react";
import { View } from "react-native";
import { GitBranch } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { appStatusClasses, appStatusColors, normalizeAppStatusKind } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

// Visual status indicator used across the sidebar tree, main-panel cards, and
// service detail screen. A solid colored circle rather than the `●` text
// glyph — stays crisp at small sizes and aligns reliably with sibling text.

const SIZE_CLASS: Record<"sm" | "md" | "lg", string> = {
  sm: "w-2 h-2",
  md: "w-2.5 h-2.5",
  lg: "w-3 h-3",
};

export function StatusDot({ status, size = "sm" }: { status: string; size?: "sm" | "md" | "lg" }) {
  const colors = appStatusColors(status);
  return (
    <View
      className={cn("rounded-full", SIZE_CLASS[size])}
      style={{ backgroundColor: colors.foreground }}
    />
  );
}

// Shape encodes entity type (mirrors the TUI): circle = agent, square =
// worktree, diamond = service. Fill encodes status. Offline/service-off default
// to a hollow muted ring so inactive rows do not look like active gray work.
export function StatusDotMini({
  status,
  hollow,
  shape = "circle",
  outline,
  color,
}: {
  status?: string;
  hollow?: boolean;
  shape?: "circle" | "square" | "diamond";
  outline?: boolean;
  color?: string;
}) {
  const cornerClass = shape === "circle" ? "rounded-full" : "rounded-[1.5px]";
  const rotateClass = shape === "diamond" ? "rotate-45" : "";
  const statusKind = normalizeAppStatusKind(status);
  const effectiveHollow = hollow ?? (statusKind === "offline" || statusKind === "serviceOff");
  const colors = appStatusColors(status);
  const foreground = color ?? colors.foreground;

  // Outline keeps the worktree square shape visually stronger, but active
  // states still fill with their semantic color so native surfaces do not read
  // as black squares.
  if (outline) {
    const size = shape === "diamond" ? "h-[7px] w-[7px]" : "h-2 w-2";
    return (
      <View
        className={cn(size, cornerClass, rotateClass, "border-2")}
        style={{
          backgroundColor: effectiveHollow ? "transparent" : foreground,
          borderColor: effectiveHollow ? "#44464e" : foreground,
        }}
      />
    );
  }

  const sizeClass = shape === "diamond" ? "h-[6px] w-[6px]" : "h-[7px] w-[7px]";
  if (effectiveHollow) {
    return (
      <View
        className={cn(sizeClass, cornerClass, rotateClass, "border-[1.5px] border-[#44464e]")}
      />
    );
  }
  return (
    <View
      className={cn(sizeClass, cornerClass, rotateClass)}
      style={{ backgroundColor: foreground }}
    />
  );
}

// Branch pill (revived from the pre-restyle design): a GitBranch glyph + the
// branch name in a subtle bordered mono chip. Shared by the sidebar tree and
// the full-width dashboard so worktree branch suffixes read identically.
export function BranchChip({ branch }: { branch: string }) {
  return (
    <View className="min-w-0 shrink flex-row items-center rounded border border-[#2a2b31] bg-[#1f2025] px-1.5 py-0.5">
      <GitBranch size={10} color="#787a83" />
      <Text
        className="ml-1 min-w-0 shrink font-mono text-[11px] text-[#a6a8b0]"
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {branch}
      </Text>
    </View>
  );
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
  const tone = appStatusClasses(status);
  const colors = appStatusColors(status);
  return (
    <View
      className={cn("rounded border px-1.5 py-0.5", tone.bg)}
      style={{ backgroundColor: colors.background, borderColor: colors.border }}
    >
      <Text
        className={cn("text-[10px] font-medium uppercase tracking-wide", tone.text)}
        style={{ color: colors.foreground }}
      >
        {status}
      </Text>
    </View>
  );
}
