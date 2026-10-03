import React, { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { usePathname } from "expo-router";
import { useAtomValue } from "jotai";
import { PairDeviceDialog, APPROVE_COMMAND } from "@/components/PairDeviceDialog";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useRouteShare } from "@/lib/use-route-share";
import {
  departedMachineIdsAtom,
  relayConfiguredAtom,
  relayMachinesAtom,
  relayPendingApprovalAtom,
  relayStatusAtom,
} from "@/stores/relay";
import { projectsAtom } from "@/stores/projects";
import { useRouteProject } from "@/lib/use-route-project";
import { machinePanelRows, machinePillState } from "@/lib/machine-pill";
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
  client_storage_error: { label: "Storage unavailable", dot: "bg-red-500", text: "text-red-400" },
  disconnected: { label: "Remote offline", dot: "bg-zinc-600", text: "text-zinc-500" },
};

export function RelayIndicator() {
  const configured = useAtomValue(relayConfiguredAtom);
  const status = useAtomValue(relayStatusAtom);
  const pendingApproval = useAtomValue(relayPendingApprovalAtom);
  const machines = useAtomValue(relayMachinesAtom);
  const departedMachineIds = useAtomValue(departedMachineIdsAtom);
  const projects = useAtomValue(projectsAtom);
  const { project } = useRouteProject();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const activeShare = useRouteShare();
  const pathname = usePathname();
  const isShareSurface = pathname === "/shares" || pathname.startsWith("/shares/");
  if (!configured) return null;

  // A guest is told nothing about the fleet, and a device waiting for approval
  // has something more urgent to say, so both come before the machine label.
  const pill = machinePillState({
    machines,
    departedMachineIds,
    currentMachineId: project?.machineId,
    currentMachineName: project?.machineName,
  });
  const showMachine =
    !activeShare && !isShareSurface && status === "connected" && pill.openable && pill.label;
  const meta =
    activeShare || isShareSurface
      ? { label: "Shared", dot: "bg-sky-500", text: "text-sky-300" }
      : status === "device_pending" && pendingApproval?.approvalCode
        ? { ...STATUS_META.device_pending, label: `Code ${pendingApproval.approvalCode}` }
        : showMachine
          ? {
              label: pill.label!,
              dot: pill.online ? "bg-emerald-500" : "bg-zinc-500",
              text: pill.online ? "text-emerald-400" : "text-zinc-400",
            }
          : STATUS_META[status];
  const canOpenPairingHelp = !activeShare && !isShareSurface && status === "device_pending";
  const canOpenMachinePanel = Boolean(showMachine);

  return (
    <View style={{ position: "relative" }}>
      <Pressable
        accessibilityHint={
          canOpenPairingHelp
            ? `Run ${APPROVE_COMMAND} on your Mac to approve this device.`
            : undefined
        }
        accessibilityLabel={
          canOpenPairingHelp
            ? "Pair device approval code"
            : canOpenMachinePanel
              ? `Machines, currently ${pill.label}`
              : "Remote status"
        }
        disabled={!canOpenPairingHelp && !canOpenMachinePanel}
        onHoverIn={Platform.OS === "web" ? () => setHovered(true) : undefined}
        onHoverOut={Platform.OS === "web" ? () => setHovered(false) : undefined}
        onPress={() => {
          if (canOpenPairingHelp) setDialogOpen(true);
          else if (canOpenMachinePanel) setPanelOpen(true);
        }}
        className={cn(
          "flex-row items-center rounded-md border border-border bg-secondary px-2 py-1",
          canOpenPairingHelp || canOpenMachinePanel ? "active:bg-accent" : "",
        )}
      >
        <View className={cn("mr-1.5 h-1.5 w-1.5 rounded-full", meta.dot)} />
        <Text
          className={cn("max-w-[10rem] text-[11px] font-medium", meta.text)}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {meta.label}
        </Text>
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
      {panelOpen ? (
        <MachinePanel
          rows={machinePanelRows({ machines, projects, currentMachineId: project?.machineId })}
          onDismiss={() => setPanelOpen(false)}
        />
      ) : null}
    </View>
  );
}

// Every machine at once, including the ones that are away: the pill's job is
// to say where the app is talking to, and which hosts it could be.
function MachinePanel({
  rows,
  onDismiss,
}: {
  rows: ReturnType<typeof machinePanelRows>;
  onDismiss: () => void;
}) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} className="bg-black/50" />
      <View pointerEvents="box-none" className="flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-sm gap-1 p-4">
          <Text className="text-[13px] font-semibold text-foreground">Machines</Text>
          <Text className="mb-2 text-[12px] text-muted-foreground">
            Every machine signed in to this account.
          </Text>
          {rows.length === 0 ? (
            <Text className="text-[12px] text-muted-foreground">No machine is connected.</Text>
          ) : (
            rows.map((row) => (
              <View key={row.id} className="flex-row items-center gap-2 py-1">
                <View
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    row.online ? "bg-emerald-500" : "bg-zinc-500",
                  )}
                />
                <Text
                  className={cn(
                    "min-w-0 flex-1 font-mono text-[12px]",
                    row.online ? "text-foreground" : "text-muted-foreground",
                  )}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {row.name}
                  {row.current ? " — open" : ""}
                </Text>
                <Text className="text-[11px] text-muted-foreground">
                  {row.online
                    ? `${row.projectCount} project${row.projectCount === 1 ? "" : "s"}`
                    : "offline"}
                </Text>
              </View>
            ))
          )}
        </Card>
      </View>
    </Modal>
  );
}
