import React, { useEffect } from "react";
import type { ViewStyle } from "react-native";
import Reanimated, {
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const CHAT_CHROME_ANIMATION_MS = 120;
const CHAT_CHROME_DEFAULT_HIDE_DISTANCE = 96;

export function ChatChromeMotion({
  children,
  direction,
  distance = CHAT_CHROME_DEFAULT_HIDE_DISTANCE,
  style,
  visible,
}: {
  children: React.ReactNode;
  direction: "bottom" | "top";
  distance?: number;
  style?: ViewStyle;
  visible: boolean;
}) {
  const progress = useSharedValue(visible ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, {
      duration: CHAT_CHROME_ANIMATION_MS,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [progress, visible]);

  const animatedStyle = useAnimatedStyle(() => {
    const hiddenDistance = direction === "top" ? -distance : distance;
    return {
      opacity: progress.value,
      transform: [{ translateY: hiddenDistance * (1 - progress.value) }],
    };
  }, [direction, distance, progress]);

  return (
    <Reanimated.View
      pointerEvents={visible ? "auto" : "none"}
      style={[{ flexShrink: 0 }, style, animatedStyle]}
    >
      {children}
    </Reanimated.View>
  );
}
