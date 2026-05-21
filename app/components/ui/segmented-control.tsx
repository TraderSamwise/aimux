import * as React from "react";
import { View, Pressable } from "react-native";
import { cn } from "@/lib/utils";
import { Text } from "./text";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** When true, segments stretch equally to fill available width */
  fullWidth?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  fullWidth,
  className,
}: SegmentedControlProps<T>) {
  return (
    <View
      className={cn(
        "flex-row rounded-lg border border-border overflow-hidden",
        !fullWidth && "self-start",
        className,
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            className={cn(fullWidth ? "flex-1 px-3 py-2" : "px-3 py-1.5", selected && "bg-primary")}
            onPress={() => onChange(opt.value)}
          >
            <Text
              className={cn(
                "text-sm text-center",
                selected ? "text-primary-foreground" : "text-foreground",
              )}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
