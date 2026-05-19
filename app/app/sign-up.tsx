import React, { useRef, useState } from "react";
import { View, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { useSignUp } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";

export default function SignUpScreen() {
  const { signUp, setActive, isLoaded } = useSignUp();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  async function handleSignUp() {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      await signUp.create({ emailAddress: email, password });
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setPendingVerification(true);
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage ?? "Sign up failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage ?? "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleResendCode() {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setCode("");
    } catch (err: any) {
      setError(err.errors?.[0]?.longMessage ?? "Failed to resend code");
    } finally {
      setLoading(false);
    }
  }

  function handleBack() {
    setPendingVerification(false);
    setCode("");
    setError("");
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View className="flex-1 justify-center px-8">
        <Text className="text-3xl font-bold text-foreground text-center mb-8">Create Account</Text>

        {!pendingVerification ? (
          <>
            <TextInput
              className="h-12 rounded-lg border border-border bg-background px-4 text-foreground mb-3"
              placeholder="Email"
              placeholderTextColor="#9ca3af"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              blurOnSubmit={false}
            />

            <TextInput
              ref={passwordRef}
              className="h-12 rounded-lg border border-border bg-background px-4 text-foreground mb-3"
              placeholder="Password"
              placeholderTextColor="#9ca3af"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="newPassword"
              returnKeyType="go"
              onSubmitEditing={handleSignUp}
            />

            {error ? <Text className="text-red-500 text-sm mb-3">{error}</Text> : null}

            <Button
              label={loading ? "Creating account..." : "Sign Up"}
              onPress={handleSignUp}
              disabled={loading}
            />

            <Button
              className="mt-3"
              variant="ghost"
              label="Already have an account? Sign In"
              onPress={() => router.back()}
            />
          </>
        ) : (
          <>
            <Text className="text-muted-foreground text-center mb-4">
              We sent a verification code to {email}
            </Text>

            <TextInput
              className="h-12 rounded-lg border border-border bg-background px-4 text-foreground mb-3 text-center text-lg tracking-widest"
              placeholder="Verification code"
              placeholderTextColor="#9ca3af"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              returnKeyType="go"
              onSubmitEditing={handleVerify}
            />

            {error ? <Text className="text-red-500 text-sm mb-3">{error}</Text> : null}

            <Button
              label={loading ? "Verifying..." : "Verify Email"}
              onPress={handleVerify}
              disabled={loading}
            />

            <Button
              className="mt-2"
              variant="ghost"
              label="Resend code"
              onPress={handleResendCode}
              disabled={loading}
            />

            <Button
              className="mt-1"
              variant="ghost"
              label="Use a different email"
              onPress={handleBack}
            />
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
