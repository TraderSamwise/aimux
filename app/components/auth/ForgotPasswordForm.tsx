import React, { useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

interface ForgotPasswordFormProps {
  loading: boolean;
  error: string;
  onSubmit: (email: string) => void | Promise<void>;
  onBack: () => void;
}

export function ForgotPasswordForm({ loading, error, onSubmit, onBack }: ForgotPasswordFormProps) {
  const [email, setEmail] = useState("");

  return (
    <View>
      <Text className="text-muted-foreground mb-5">
        Enter your email and we’ll send a code to reset your password.
      </Text>

      <Text className="text-[12px] font-medium text-muted-foreground mb-1.5">Email</Text>
      <Input
        placeholder="you@example.com"
        placeholderTextColor="hsl(var(--muted-foreground))"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        returnKeyType="go"
        onSubmitEditing={() => onSubmit(email)}
      />

      {error ? <Text className="text-destructive text-sm mt-3">{error}</Text> : null}

      <Button
        className="mt-5"
        label={loading ? "Sending…" : "Send reset code"}
        onPress={() => onSubmit(email)}
        disabled={loading}
      />

      <Button className="mt-2" variant="ghost" label="Back to sign in" onPress={onBack} />
    </View>
  );
}
