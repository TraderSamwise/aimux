import React, { useEffect } from "react";
import { Pressable, type ViewStyle } from "react-native";
import { ChevronDown } from "lucide-react-native";
import Reanimated, {
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { Text } from "@/components/ui/text";

type ChatNewMessagesBadgeProps = {
  count: number;
  onPress: () => void;
  style?: ViewStyle;
  visible: boolean;
};

export function ChatNewMessagesBadge({
  count,
  onPress,
  style,
  visible,
}: ChatNewMessagesBadgeProps) {
  const progress = useSharedValue(visible ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, {
      duration: 140,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [progress, visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 6 }, { scale: 0.96 + progress.value * 0.04 }],
  }));

  const label = count === 1 ? "1 new message" : `${count} new messages`;

  return (
    <Reanimated.View
      pointerEvents={visible && count > 0 ? "box-none" : "none"}
      style={[style, animatedStyle]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        className="h-9 flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3 shadow-sm active:opacity-80"
        onPress={onPress}
      >
        <Text className="text-sm font-semibold text-foreground">{label}</Text>
        <ChevronDown size={15} color="#a1a1aa" />
      </Pressable>
    </Reanimated.View>
  );
}
