import React, { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { Eye, EyeOff } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

export type EmailPasswordMode = "sign-in" | "sign-up";

interface EmailPasswordFormProps {
  mode: EmailPasswordMode;
  loading: boolean;
  error: string;
  onSubmit: (values: { email: string; password: string }) => void | Promise<void>;
  onForgotPassword?: () => void;
}

export function EmailPasswordForm({
  mode,
  loading,
  error,
  onSubmit,
  onForgotPassword,
}: EmailPasswordFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const submit = () => onSubmit({ email, password });
  const submitLabel = mode === "sign-in" ? "Sign in" : "Create account";
  const loadingLabel = mode === "sign-in" ? "Signing in…" : "Creating account…";

  return (
    <View>
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
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        blurOnSubmit={false}
      />

      <View className="mt-3 flex-row items-center justify-between mb-1.5">
        <Text className="text-[12px] font-medium text-muted-foreground">Password</Text>
        {mode === "sign-in" && onForgotPassword ? (
          <Text
            onPress={onForgotPassword}
            className="text-[12px] text-foreground underline decoration-muted-foreground"
          >
            Forgot password?
          </Text>
        ) : null}
      </View>
      <View className="relative">
        <Input
          ref={passwordRef}
          className="pr-10"
          placeholder={mode === "sign-up" ? "At least 8 characters" : "••••••••"}
          placeholderTextColor="hsl(var(--muted-foreground))"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          textContentType={mode === "sign-up" ? "newPassword" : "password"}
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <View className="absolute right-2 top-0 h-11 justify-center">
          <Text
            onPress={() => setShowPassword((v) => !v)}
            className="px-2 py-1"
            accessibilityRole="button"
            accessibilityLabel={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? (
              <EyeOff size={16} color="hsl(var(--muted-foreground))" />
            ) : (
              <Eye size={16} color="hsl(var(--muted-foreground))" />
            )}
          </Text>
        </View>
      </View>

      {error ? <Text className="text-destructive text-sm mt-3">{error}</Text> : null}

      <Button
        className="mt-5"
        label={loading ? loadingLabel : submitLabel}
        onPress={submit}
        disabled={loading}
      />
    </View>
  );
}
