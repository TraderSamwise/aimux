import React from "react";
import { View } from "react-native";
import { Camera, Mic, Send } from "lucide-react-native";
import { useAtom } from "jotai";
import { Page, PageHeader } from "@/components/PageLayout";
import { MonitorCapturePanel } from "@/components/MonitorCapturePanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
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
  const targetDetail = settings.sessionId ?? "Choose a destination before starting.";

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

        <MonitorCapturePanel />
      </View>
    </Page>
  );
}
