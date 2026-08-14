import React from "react";
import { ScrollView, View } from "react-native";
import { Camera, Clock, Mic, Send } from "lucide-react-native";
import { useAtomValue } from "jotai";
import { Text } from "@/components/ui/text";
import { monitorSettingsAtom } from "@/stores/settings";

const SIDEBAR_WIDTH = 320;

export function MonitorSidebar() {
  const settings = useAtomValue(monitorSettingsAtom);
  const targetLabel =
    settings.targetKind === "shared-chat" ? "Shared chat target" : "Project agent target";
  const targetDetail = settings.sessionId ?? "No target selected";
  const captureLabel =
    settings.captureMode === "camera-audio"
      ? "Camera + audio"
      : settings.captureMode === "audio"
        ? "Audio"
        : "Camera";

  return (
    <View
      className="border-r border-[#2a2b31] bg-[#161719]"
      style={{ width: SIDEBAR_WIDTH, height: "100%" }}
    >
      <ScrollView className="flex-1">
        <View className="border-b border-[#2a2b31] px-4 py-4">
          <Text className="text-[10px] font-bold uppercase tracking-widest text-[#787a83]">
            Monitor
          </Text>
          <Text className="mt-2 text-[18px] font-semibold text-[#edeef0]">Monitor mode</Text>
          <Text className="mt-1 text-[12px] text-[#787a83]">Live note-taking coach context</Text>
        </View>

        <View className="gap-4 px-4 py-4">
          <View className="flex-row gap-3">
            <Camera size={16} color="#38bdf8" />
            <View className="min-w-0 flex-1">
              <Text className="text-[13px] font-medium text-[#edeef0]">Camera</Text>
              <Text className="mt-0.5 text-[12px] text-[#787a83]">{captureLabel}</Text>
            </View>
          </View>
          <View className="flex-row gap-3">
            <Mic size={16} color={settings.speechToText ? "#38bdf8" : "#787a83"} />
            <View className="min-w-0 flex-1">
              <Text className="text-[13px] font-medium text-[#edeef0]">Speech to text</Text>
              <Text className="mt-0.5 text-[12px] text-[#787a83]">
                {settings.speechToText ? "Enabled" : "Disabled"}
              </Text>
            </View>
          </View>
          <View className="flex-row gap-3">
            <Clock size={16} color="#a1a1aa" />
            <View className="min-w-0 flex-1">
              <Text className="text-[13px] font-medium text-[#edeef0]">
                Every {settings.intervalSeconds}s
              </Text>
              <Text className="mt-0.5 text-[12px] text-[#787a83]">Snapshot interval</Text>
            </View>
          </View>
          <View className="flex-row gap-3">
            <Send size={16} color="#a1a1aa" />
            <View className="min-w-0 flex-1">
              <Text className="text-[13px] font-medium text-[#edeef0]">{targetLabel}</Text>
              <Text
                className="mt-0.5 font-mono text-[12px] text-[#787a83]"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {targetDetail}
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
