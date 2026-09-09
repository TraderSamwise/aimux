import React, { useEffect } from "react";
import type { ViewStyle } from "react-native";
import { useColorScheme } from "nativewind";
import Reanimated, {
  Easing as ReanimatedEasing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

const CHAT_TOP_EDGE_FADE_MS = 110;
const CHAT_TOP_EDGE_FADE_TAIL = 14;
const CHAT_TOP_EDGE_FADE_MIN_HEIGHT = 18;

export function ChatTopEdgeFade({ topInset, visible }: { topInset: number; visible: boolean }) {
  const { colorScheme } = useColorScheme();
  const progress = useSharedValue(visible ? 1 : 0);
  const background = colorScheme === "light" ? "#ffffff" : "#09090b";
  const height = Math.max(CHAT_TOP_EDGE_FADE_MIN_HEIGHT, topInset + CHAT_TOP_EDGE_FADE_TAIL);

  useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, {
      duration: CHAT_TOP_EDGE_FADE_MS,
      easing: ReanimatedEasing.out(ReanimatedEasing.quad),
      reduceMotion: ReduceMotion.System,
    });
  }, [progress, visible]);

  const animatedStyle = useAnimatedStyle<ViewStyle>(
    () => ({
      opacity: progress.value,
    }),
    [progress],
  );

  return (
    <Reanimated.View
      pointerEvents="none"
      style={[
        {
          height,
          left: 0,
          position: "absolute",
          right: 0,
          top: 0,
          zIndex: 55,
        },
        animatedStyle,
      ]}
    >
      <Svg height="100%" preserveAspectRatio="none" viewBox="0 0 1 1" width="100%">
        <Defs>
          <LinearGradient id="chatTopEdgeFade" x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor={background} stopOpacity="0.72" />
            <Stop offset="1" stopColor={background} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect fill="url(#chatTopEdgeFade)" height="1" width="1" x="0" y="0" />
      </Svg>
    </Reanimated.View>
  );
}
