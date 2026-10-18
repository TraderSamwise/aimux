import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type { UsageSnapshot } from "../../src/project-api-contract";

export function UsageMonitor({ usage }: { usage?: UsageSnapshot }) {
  if (!usage) return null;
  return (
    <View className="mb-4 rounded-lg border border-[#26272d] bg-[#15161a] p-4">
      <Text className="mb-2 font-mono text-xs font-semibold text-[#b8bbc6]">Usage</Text>
      {usage.displayLines.map((line, index) => (
        <Text key={index} className="font-mono text-xs text-[#b8bbc6]">
          {line}
        </Text>
      ))}
    </View>
  );
}
