import React, { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { usePathname } from "expo-router";
import { useAtomValue } from "jotai";
import { PairDeviceDialog, APPROVE_COMMAND } from "@/components/PairDeviceDialog";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useRouteShare } from "@/lib/use-route-share";
import { relayConfiguredAtom, relayPendingApprovalAtom, relayStatusAtom } from "@/stores/relay";
import type { RelayStatus } from "@/lib/relay-transport";

// Compact relay connection pill for the TopBar. Hidden entirely when no relay
// is configured (local-only deployments). Shows a colored dot + label tied to
// the live RelayTransport status.

const STATUS_META: Record<RelayStatus, { label: string; dot: string; text: string }> = {
  connected: { label: "Remote", dot: "bg-emerald-500", text: "text-emerald-400" },
  connecting: { label: "Connecting", dot: "bg-amber-500", text: "text-amber-400" },
  device_pending: { label: "Approval needed", dot: "bg-amber-500", text: "text-amber-300" },
  daemon_offline: { label: "Host offline", dot: "bg-zinc-500", text: "text-zinc-400" },
  relay_unavailable: { label: "Remote unavailable", dot: "bg-zinc-600", text: "text-zinc-400" },
  auth_failed: { label: "Remote blocked", dot: "bg-red-500", text: "text-red-400" },
  disconnected: { label: "Remote offline", dot: "bg-zinc-600", text: "text-zinc-500" },
};

export function RelayIndicator() {
  const configured = useAtomValue(relayConfiguredAtom);
  const status = useAtomValue(relayStatusAtom);
  const pendingApproval = useAtomValue(relayPendingApprovalAtom);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const activeShare = useRouteShare();
  const pathname = usePathname();
  const isShareSurface = pathname === "/shares" || pathname.startsWith("/shares/");
  if (!configured) return null;

  const meta =
    activeShare || isShareSurface
      ? { label: "Shared", dot: "bg-sky-500", text: "text-sky-300" }
      : status === "device_pending" && pendingApproval?.approvalCode
        ? { ...STATUS_META.device_pending, label: `Code ${pendingApproval.approvalCode}` }
        : STATUS_META[status];
  const canOpenPairingHelp = !activeShare && !isShareSurface && status === "device_pending";

  return (
    <View style={{ position: "relative" }}>
      <Pressable
        accessibilityHint={
          canOpenPairingHelp
            ? `Run ${APPROVE_COMMAND} on your Mac to approve this device.`
            : undefined
        }
        accessibilityLabel={canOpenPairingHelp ? "Pair device approval code" : "Remote status"}
        disabled={!canOpenPairingHelp}
        onHoverIn={Platform.OS === "web" ? () => setHovered(true) : undefined}
        onHoverOut={Platform.OS === "web" ? () => setHovered(false) : undefined}
        onPress={() => {
          if (canOpenPairingHelp) setDialogOpen(true);
        }}
        className={cn(
          "flex-row items-center rounded-md border border-border bg-secondary px-2 py-1",
          canOpenPairingHelp ? "active:bg-accent" : "",
        )}
      >
        <View className={cn("mr-1.5 h-1.5 w-1.5 rounded-full", meta.dot)} />
        <Text className={cn("text-[11px] font-medium", meta.text)}>{meta.label}</Text>
      </Pressable>
      {canOpenPairingHelp && hovered ? (
        <View
          pointerEvents="none"
          className="absolute right-0 top-9 z-50 w-72 rounded-lg border border-border bg-popover p-3 shadow-lg"
        >
          <Text className="text-[12px] font-semibold text-foreground">Pair this browser</Text>
          <Text className="mt-1 text-[12px] text-muted-foreground">
            Click for details, or run {APPROVE_COMMAND} on your Mac and match the code.
          </Text>
        </View>
      ) : null}
      {dialogOpen ? <PairDeviceDialog onDismiss={() => setDialogOpen(false)} /> : null}
    </View>
  );
}
