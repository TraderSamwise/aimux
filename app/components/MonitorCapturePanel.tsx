import React from "react";
import { View } from "react-native";
import { Camera, Mic } from "lucide-react-native";
import { useAtomValue } from "jotai";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { monitorSettingsAtom } from "@/stores/settings";
import type { MonitorCapturePanelProps } from "@/lib/monitor-capture";

export function MonitorCapturePanel(_props: MonitorCapturePanelProps = {}) {
  const settings = useAtomValue(monitorSettingsAtom);

  return (
    <Card className="rounded-lg p-5">
      <View className="gap-4 md:flex-row md:items-center md:justify-between">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-foreground">Phone monitor</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Open Monitor in the native app to capture camera and microphone context.
          </Text>
        </View>
        <View className="flex-row gap-2">
          <View className="h-10 w-10 items-center justify-center rounded-lg border border-border">
            <Camera size={18} color="#a1a1aa" />
          </View>
          <View className="h-10 w-10 items-center justify-center rounded-lg border border-border">
            <Mic size={18} color={settings.speechToText ? "#38bdf8" : "#a1a1aa"} />
          </View>
        </View>
      </View>

      <View className="mt-5 gap-2 rounded-lg border border-border bg-background p-4">
        <Text className="text-sm text-muted-foreground">Interval: {settings.intervalSeconds}s</Text>
        <Text className="text-sm text-muted-foreground">
          Speech: {settings.speechToText ? "on" : "off"} - {settings.speechLanguage} -{" "}
          {settings.audioSampleRate} Hz
        </Text>
        <Text className="text-sm text-muted-foreground">
          Recognition: {settings.speechOnDeviceOnly ? "on-device only" : "system default"}
        </Text>
      </View>
    </Card>
  );
}
