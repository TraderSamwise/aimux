import React, { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { useAtomValue } from "jotai";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { relayPendingApprovalAtom, relayStatusAtom } from "@/stores/relay";

const APPROVE_COMMAND = "aimux security device approve";

/**
 * Shown only once the operator asks for something the host has to answer, so a
 * device that is merely unapproved does not open onto a wall. Clears itself the
 * moment the relay reports the pairing went through — nothing to refresh.
 */
export function PairDeviceDialog({ onDismiss }: { onDismiss?: () => void }) {
  const status = useAtomValue(relayStatusAtom);
  const pendingApproval = useAtomValue(relayPendingApprovalAtom);
  const [copied, setCopied] = useState(false);

  if (status !== "device_pending") return null;

  const code = pendingApproval?.approvalCode;

  async function copyCommand() {
    if (Platform.OS !== "web") return;
    try {
      await navigator.clipboard.writeText(APPROVE_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied — the command is on screen to type.
    }
  }

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onDismiss}>
      <Pressable onPress={onDismiss} style={StyleSheet.absoluteFill} className="bg-black/60" />
      <View className="flex-1 items-center justify-center p-6" pointerEvents="box-none">
        <Card className="w-full max-w-sm p-5">
          <Text className="text-lg font-semibold text-foreground">Pair this device</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            This browser has not been approved for your aimux host yet.
          </Text>

          {code ? (
            <View className="mt-5 items-center rounded-lg border border-border bg-secondary py-4">
              <Text className="font-mono text-2xl font-bold tracking-[0.3em] text-foreground">
                {code}
              </Text>
            </View>
          ) : null}

          <Text className="mt-5 text-sm font-medium text-foreground">Approve it on your Mac</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Open the aimux notification that just appeared{code ? " and match the code" : ""}, or
            run:
          </Text>
          <Pressable
            onPress={copyCommand}
            disabled={Platform.OS !== "web"}
            className="mt-2 rounded-md border border-border bg-secondary px-3 py-2"
          >
            <Text className="font-mono text-[12px] text-foreground" selectable>
              {APPROVE_COMMAND}
            </Text>
            {Platform.OS === "web" ? (
              <Text className="mt-1 text-[11px] text-muted-foreground">
                {copied ? "Copied." : "Tap to copy."}
              </Text>
            ) : null}
          </Pressable>

          <Text className="mt-5 text-[12px] text-muted-foreground">
            Waiting for approval — this connects on its own once you approve.
          </Text>
        </Card>
      </View>
    </Modal>
  );
}
