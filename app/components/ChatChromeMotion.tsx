import React, { useEffect } from "react";
import type { ViewStyle } from "react-native";
import Reanimated, {
  Easing as ReanimatedEasing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const CHAT_CHROME_REVEAL_MS = 130;
const CHAT_CHROME_HIDE_MS = 95;
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
      duration: visible ? CHAT_CHROME_REVEAL_MS : CHAT_CHROME_HIDE_MS,
      easing: visible
        ? ReanimatedEasing.out(ReanimatedEasing.cubic)
        : ReanimatedEasing.in(ReanimatedEasing.quad),
      reduceMotion: ReduceMotion.System,
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
