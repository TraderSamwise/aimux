import React from "react";
import { ScrollView, View } from "react-native";
import { X } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";

export function DetailPanel({
  title,
  meta,
  icon,
  children,
  onClose,
}: {
  title: string;
  meta?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <Card className="min-h-[420px] flex-1 rounded-xl p-0">
      <View className="flex-row items-center border-b border-border px-4 py-3">
        {icon ? <View className="mr-2">{icon}</View> : null}
        <View className="min-w-0 flex-1">
          <Text className="text-[16px] font-bold text-foreground" numberOfLines={1}>
            {title}
          </Text>
          {meta ? (
            <Text className="mt-1 text-[11px] uppercase tracking-widest text-muted-foreground">
              {meta}
            </Text>
          ) : null}
        </View>
        {onClose ? (
          <Button variant="ghost" size="icon" onPress={onClose} accessibilityLabel="Close detail">
            <X size={17} color="#a1a1aa" />
          </Button>
        ) : null}
      </View>
      <ScrollView className="max-h-[620px] px-4 py-4">{children}</ScrollView>
    </Card>
  );
}

export function DetailEmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <Card className="min-h-[220px] flex-1 items-center justify-center rounded-xl p-6">
      <Text className="text-base font-semibold text-foreground">{title}</Text>
      {body ? <Text className="mt-1 text-center text-sm text-muted-foreground">{body}</Text> : null}
    </Card>
  );
}
