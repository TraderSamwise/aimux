import React, { useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

interface VerificationFormProps {
  email: string;
  loading: boolean;
  error: string;
  submitLabel: string;
  onSubmit: (code: string) => void | Promise<void>;
  onResend: () => void | Promise<void>;
  onBack: () => void;
  /** Optional extra field (used by password reset to collect the new password) */
  extra?: React.ReactNode;
}

export function VerificationForm({
  email,
  loading,
  error,
  submitLabel,
  onSubmit,
  onResend,
  onBack,
  extra,
}: VerificationFormProps) {
  const [code, setCode] = useState("");

  return (
    <View>
      <Text className="text-muted-foreground text-center mb-5">
        We sent a verification code to{"\n"}
        <Text className="text-foreground">{email}</Text>
      </Text>

      <Input
        className="text-center text-lg tracking-[0.5em]"
        placeholder="123456"
        placeholderTextColor="hsl(var(--muted-foreground))"
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        returnKeyType="go"
        onSubmitEditing={() => onSubmit(code)}
      />

      {extra ? <View className="mt-3">{extra}</View> : null}

      {error ? <Text className="text-destructive text-sm mt-3">{error}</Text> : null}

      <Button
        className="mt-5"
        label={loading ? "Verifying…" : submitLabel}
        onPress={() => onSubmit(code)}
        disabled={loading}
      />

      <View className="flex-row items-center justify-center mt-4 gap-1">
        <Text className="text-[13px] text-muted-foreground">Didn’t get it?</Text>
        <Text
          onPress={() => onResend()}
          className="text-[13px] text-foreground underline decoration-muted-foreground"
        >
          Resend
        </Text>
        <Text className="text-[13px] text-muted-foreground">·</Text>
        <Text
          onPress={onBack}
          className="text-[13px] text-foreground underline decoration-muted-foreground"
        >
          Back
        </Text>
      </View>
    </View>
  );
}
