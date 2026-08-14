import React, { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Camera, MessageSquare, Mic, Send } from "lucide-react-native";
import { useAtom, useAtomValue } from "jotai";
import { Page, PageHeader } from "@/components/PageLayout";
import { MonitorCapturePanel } from "@/components/MonitorCapturePanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { sendLivePaneInput, uploadImageAttachment } from "@/lib/api";
import { useAuth, useUser } from "@/lib/auth";
import {
  formatMonitorSampleText,
  type MonitorCapturePanelProps,
  type MonitorSample,
} from "@/lib/monitor-capture";
import { monitorTargetLabel, type MonitorTarget } from "@/lib/monitor-targets";
import { resolveSharedChatActor } from "@/lib/shared-chat-actor";
import { monitorTargetsAtom, selectedMonitorTargetAtom } from "@/stores/monitorTargets";
import {
  MONITOR_AUDIO_SAMPLE_RATES,
  MONITOR_INTERVAL_SECONDS,
  monitorSettingsAtom,
  type MonitorAudioSampleRate,
  type MonitorCaptureMode,
  type MonitorTargetKind,
} from "@/stores/settings";

const TARGET_OPTIONS: Array<{ value: MonitorTargetKind; label: string }> = [
  { value: "project-agent", label: "Project agent" },
  { value: "shared-chat", label: "Shared chat" },
];

const INTERVAL_OPTIONS = MONITOR_INTERVAL_SECONDS.map((value) => ({
  value: String(value),
  label: `${value}s`,
}));

const SAMPLE_RATE_OPTIONS = MONITOR_AUDIO_SAMPLE_RATES.map((value) => ({
  value: String(value),
  label: `${value / 1000}k`,
}));

const CAPTURE_OPTIONS: Array<{ value: MonitorCaptureMode; label: string }> = [
  { value: "camera", label: "Camera" },
  { value: "audio", label: "Audio" },
  { value: "camera-audio", label: "Both" },
];

const RECOGNITION_OPTIONS: Array<{ value: "on-device" | "system"; label: string }> = [
  { value: "on-device", label: "On-device" },
  { value: "system", label: "System" },
];

const INTERIM_OPTIONS: Array<{ value: "interim" | "final"; label: string }> = [
  { value: "interim", label: "Live" },
  { value: "final", label: "Final" },
];

export default function MonitorScreen() {
  const [settings, setSettings] = useAtom(monitorSettingsAtom);
  const targets = useAtomValue(monitorTargetsAtom);
  const selectedTarget = useAtomValue(selectedMonitorTargetAtom);
  const { getToken, userId } = useAuth();
  const { user } = useUser();
  const [lastDelivery, setLastDelivery] = useState<string | null>(null);
  const targetDetail = monitorTargetLabel(selectedTarget);
  const filteredTargets = useMemo(
    () => targets.filter((target) => target.kind === settings.targetKind),
    [settings.targetKind, targets],
  );
  const sharedCameraOnlyBlocked =
    selectedTarget?.kind === "shared-chat" && settings.captureMode === "camera";
  const audioOnlyWithoutSpeech = settings.captureMode === "audio" && !settings.speechToText;
  const sharedTextWithoutSpeech =
    selectedTarget?.kind === "shared-chat" &&
    settings.captureMode !== "camera" &&
    !settings.speechToText;
  const deliveryEnabled =
    Boolean(selectedTarget) &&
    !sharedCameraOnlyBlocked &&
    !audioOnlyWithoutSpeech &&
    !sharedTextWithoutSpeech;
  const deliveryHint = !selectedTarget
    ? "Choose a destination before starting."
    : sharedCameraOnlyBlocked
      ? "Shared chat monitor currently sends speech text only. Switch to Audio or Both."
      : audioOnlyWithoutSpeech || sharedTextWithoutSpeech
        ? "Turn speech to text on before starting this monitor mode."
        : selectedTarget.kind === "shared-chat"
          ? "Shared chat delivery sends speech text with your signed-in identity; camera frames stay local for now."
          : null;
  const panelDeliveryHint =
    deliveryEnabled && lastDelivery ? `Last delivered at ${lastDelivery}.` : deliveryHint;

  const selectTarget = useCallback(
    (target: MonitorTarget) => {
      setSettings((current) => ({
        ...current,
        targetKind: target.kind,
        projectPath: target.kind === "project-agent" ? target.projectPath : target.projectRoot,
        sessionId: target.sessionId,
        shareOwnerUserId: target.kind === "shared-chat" ? target.ownerUserId : null,
        shareId: target.kind === "shared-chat" ? target.shareId : null,
      }));
    },
    [setSettings],
  );

  const handleSampleCaptured: MonitorCapturePanelProps["onSampleCaptured"] = useCallback(
    async (sample: MonitorSample) => {
      if (!selectedTarget) throw new Error("Choose a monitor destination first.");
      const token = await getToken();
      const transcript = sample.transcript?.trim() || null;
      let attachmentIds: string[] = [];
      let frameAttached = false;
      let frameSkippedReason: string | null = null;

      if (sample.frame && selectedTarget.kind === "project-agent") {
        const uploaded = await uploadImageAttachment(
          selectedTarget.endpoint,
          {
            filename: sample.frame.filename,
            mimeType: sample.frame.mimeType,
            dataBase64: sample.frame.dataBase64,
            sessionId: selectedTarget.sessionId,
          },
          { token },
        );
        attachmentIds = [uploaded.attachment.id];
        frameAttached = true;
      } else if (sample.frame && selectedTarget.kind === "shared-chat") {
        frameSkippedReason = "shared chat image delivery is not enabled yet";
      }

      const text = formatMonitorSampleText({
        capturedAt: sample.capturedAt,
        captureMode: settings.captureMode,
        transcript,
        frameAttached,
        frameSkippedReason,
        audioSampleRate: settings.audioSampleRate,
      });

      if (selectedTarget.kind === "shared-chat") {
        await sendLivePaneInput(selectedTarget.endpoint, selectedTarget.sessionId, text, {
          token,
          sharedChatActor: resolveSharedChatActor({
            displayName:
              user?.fullName ??
              user?.username ??
              user?.primaryEmailAddress?.emailAddress ??
              undefined,
            email: user?.primaryEmailAddress?.emailAddress ?? undefined,
            isCanonicalSharedRoute: true,
            isSharedConversation: true,
            routeOwnerUserId: selectedTarget.ownerUserId,
            userId: userId ?? undefined,
          }),
        });
      } else {
        await sendLivePaneInput(selectedTarget.endpoint, selectedTarget.sessionId, text, {
          token,
          attachmentIds,
        });
      }
      setLastDelivery(new Date().toLocaleTimeString());
    },
    [getToken, selectedTarget, settings.audioSampleRate, settings.captureMode, user, userId],
  );

  return (
    <Page>
      <PageHeader
        eyebrow="Monitor"
        title="Monitor mode"
        subtitle="Camera snapshots for live agent context"
        actions={
          <Button variant="outline" size="icon" accessibilityLabel="Monitor camera setup" disabled>
            <Camera size={18} color="#fafafa" />
          </Button>
        }
      />

      <View className="gap-4">
        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">Destination</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Pick where monitor snapshots should be delivered.
          </Text>
          <SegmentedControl
            className="mt-4"
            fullWidth
            options={TARGET_OPTIONS}
            value={settings.targetKind}
            onChange={(targetKind) => setSettings((current) => ({ ...current, targetKind }))}
          />
          <View className="mt-4 flex-row items-center gap-3 rounded-lg border border-border bg-background px-4 py-3">
            <Send size={17} color="#a1a1aa" />
            <View className="min-w-0 flex-1">
              <Text className="text-[13px] font-medium text-foreground">
                {settings.targetKind === "shared-chat" ? "Shared chat" : "Project agent"}
              </Text>
              <Text
                className="mt-0.5 font-mono text-[12px] text-muted-foreground"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {targetDetail}
              </Text>
            </View>
          </View>
          <View className="mt-4 gap-2">
            {filteredTargets.length > 0 ? (
              filteredTargets.map((target) => (
                <MonitorTargetRow
                  key={target.id}
                  selected={selectedTarget?.id === target.id}
                  target={target}
                  onPress={() => selectTarget(target)}
                />
              ))
            ) : (
              <View className="rounded-lg border border-border bg-background px-4 py-3">
                <Text className="text-sm font-medium text-foreground">No destinations</Text>
                <Text className="mt-1 text-sm text-muted-foreground">
                  {settings.targetKind === "shared-chat"
                    ? "Accepted shared chats will appear here."
                    : "Running project agents will appear here."}
                </Text>
              </View>
            )}
          </View>
        </Card>

        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">Capture</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Send visual context, spoken context, or both.
          </Text>
          <SegmentedControl
            className="mt-4"
            fullWidth
            options={CAPTURE_OPTIONS}
            value={settings.captureMode}
            onChange={(captureMode) => setSettings((current) => ({ ...current, captureMode }))}
          />
          <View className="mt-4 gap-3 md:flex-row">
            <Button
              className="gap-2 self-start"
              variant={settings.speechToText ? "secondary" : "outline"}
              onPress={() =>
                setSettings((current) => ({ ...current, speechToText: !current.speechToText }))
              }
            >
              <Mic size={16} color="#fafafa" />
              <Text className="text-sm font-medium text-foreground">
                {settings.speechToText ? "Speech to text on" : "Speech to text off"}
              </Text>
            </Button>
            <View className="min-w-0 flex-1">
              <Input
                value={settings.speechLanguage}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Speech recognition locale"
                placeholder="en-US"
                onChangeText={(speechLanguage) =>
                  setSettings((current) => ({ ...current, speechLanguage }))
                }
              />
            </View>
          </View>
        </Card>

        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">Speech recognition</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Prefer OS speech recognition and keep cloud recognition off unless explicitly enabled.
          </Text>
          <SegmentedControl
            className="mt-4"
            fullWidth
            options={RECOGNITION_OPTIONS}
            value={settings.speechOnDeviceOnly ? "on-device" : "system"}
            onChange={(value) =>
              setSettings((current) => ({
                ...current,
                speechOnDeviceOnly: value === "on-device",
              }))
            }
          />
          <SegmentedControl
            className="mt-3"
            fullWidth
            options={INTERIM_OPTIONS}
            value={settings.speechInterimResults ? "interim" : "final"}
            onChange={(value) =>
              setSettings((current) => ({
                ...current,
                speechInterimResults: value === "interim",
              }))
            }
          />
        </Card>

        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">Snapshot interval</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Monitor will capture visual frames on this cadence while it is running.
          </Text>
          <SegmentedControl
            className="mt-4"
            fullWidth
            options={INTERVAL_OPTIONS}
            value={String(settings.intervalSeconds)}
            onChange={(value) =>
              setSettings((current) => ({ ...current, intervalSeconds: Number(value) }))
            }
          />
        </Card>

        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">Audio sample rate</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Used when Monitor persists audio notes alongside speech transcripts.
          </Text>
          <SegmentedControl
            className="mt-4"
            fullWidth
            options={SAMPLE_RATE_OPTIONS}
            value={String(settings.audioSampleRate)}
            onChange={(value) =>
              setSettings((current) => ({
                ...current,
                audioSampleRate: Number(value) as MonitorAudioSampleRate,
              }))
            }
          />
        </Card>

        <MonitorCapturePanel
          deliveryEnabled={deliveryEnabled}
          deliveryLabel={selectedTarget ? monitorTargetLabel(selectedTarget) : undefined}
          deliveryHint={panelDeliveryHint}
          startDisabled={!deliveryEnabled}
          textOnlyDelivery={selectedTarget?.kind === "shared-chat"}
          onSampleCaptured={handleSampleCaptured}
        />
      </View>
    </Page>
  );
}

function MonitorTargetRow({
  selected,
  target,
  onPress,
}: {
  selected: boolean;
  target: MonitorTarget;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`rounded-lg border px-4 py-3 ${
        selected ? "border-sky-400 bg-sky-500/10" : "border-border bg-background"
      }`}
    >
      <View className="flex-row items-center gap-3">
        <MessageSquare size={17} color={selected ? "#38bdf8" : "#a1a1aa"} />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {target.kind === "shared-chat" ? target.projectName : target.sessionLabel}
          </Text>
          <Text
            className="mt-0.5 font-mono text-[12px] text-muted-foreground"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {target.kind === "shared-chat"
              ? `${target.sessionLabel} - shared`
              : `${target.projectName} - ${target.status}`}
          </Text>
        </View>
        <Text className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-400">
          {target.kind === "shared-chat" ? "shared" : "agent"}
        </Text>
      </View>
    </Pressable>
  );
}
