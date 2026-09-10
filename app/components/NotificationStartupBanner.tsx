import { View } from "react-native";
import { useAtomValue } from "jotai";
import { AlertTriangle } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { notificationStartupIssueAtom } from "@/stores/notificationStartup";

export function NotificationStartupBanner() {
  const issue = useAtomValue(notificationStartupIssueAtom);
  if (!issue) return null;

  return (
    <View className="flex-row items-start border-b border-amber-500/40 bg-amber-500/10 px-4 py-2">
      <AlertTriangle size={16} color="#fbbf24" />
      <View className="ml-2 min-w-0 flex-1">
        <Text className="text-[13px] font-semibold text-amber-200">{issue.title}</Text>
        <Text className="mt-0.5 text-[12px] text-amber-100/80">{issue.body}</Text>
      </View>
    </View>
  );
}
