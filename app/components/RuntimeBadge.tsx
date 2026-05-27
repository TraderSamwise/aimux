import React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type { RuntimeBrand } from "@/lib/runtime-brand";

export function RuntimeBadge({
  brand,
  compact = false,
}: {
  brand: RuntimeBrand;
  compact?: boolean;
}) {
  return (
    <View
      className="flex-row items-center rounded-full border px-2 py-0.5"
      style={{ borderColor: brand.color, backgroundColor: brand.background }}
    >
      <Text className="font-mono text-[10px] font-bold" style={{ color: brand.color }}>
        {compact ? brand.shortLabel : brand.label}
      </Text>
    </View>
  );
}
