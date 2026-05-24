import React, { useRef, useState } from "react";
import { View, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { useSignIn } from "@clerk/clerk-expo";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";

export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();
  const params = useLocalSearchParams<{ redirect?: string | string[] }>();
  const redirect = sanitizeRedirect(
    Array.isArray(params.redirect) ? params.redirect[0] : params.redirect,
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [code, setCode] = useState("");
  const passwordRef = useRef<TextInput>(null);

  async function handleSignIn() {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      const result = await signIn.create({
        identifier: email,
        password,
      });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        if (redirect) router.replace(redirect);
      } else if (
        result.status === "needs_second_factor" ||
        (result.status as string) === "needs_client_trust"
      ) {
        // Client trust (new device) or MFA — send email verification code
        await signIn.prepareSecondFactor({
          strategy: "email_code",
        });
        setNeedsVerification(true);
      } else {
        setError(`Sign in requires additional steps: ${result.status}`);
      }
    } catch (err: unknown) {
      setError(clerkErrorMessage(err, "Sign in failed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      const result = await signIn.attemptSecondFactor({
        strategy: "email_code",
        code,
      });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        if (redirect) router.replace(redirect);
      }
    } catch (err: unknown) {
      setError(clerkErrorMessage(err, "Verification failed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResendCode() {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      await signIn.prepareSecondFactor({ strategy: "email_code" });
      setCode("");
    } catch (err: unknown) {
      setError(clerkErrorMessage(err, "Failed to resend code"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View className="flex-1 justify-center px-8">
        <Text className="text-3xl font-mono font-bold text-foreground text-center mb-8">Aimux</Text>

        {!needsVerification ? (
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
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={handleSignIn}
            />

            {error ? <Text className="text-destructive text-sm mb-3">{error}</Text> : null}

            <Button
              label={loading ? "Signing in..." : "Sign In"}
              onPress={handleSignIn}
              disabled={loading}
            />

            <Button
              className="mt-3"
              variant="ghost"
              label="Don't have an account? Sign Up"
              onPress={() => router.push("/sign-up")}
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

            {error ? <Text className="text-destructive text-sm mb-3">{error}</Text> : null}

            <Button
              label={loading ? "Verifying..." : "Verify"}
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
              label="Back"
              onPress={() => {
                setNeedsVerification(false);
                setCode("");
                setError("");
              }}
            />
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function sanitizeRedirect(value: string | undefined): Href | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value as Href;
}

function clerkErrorMessage(err: unknown, fallback: string) {
  if (typeof err === "object" && err && "errors" in err) {
    const errors = (err as { errors?: Array<{ longMessage?: string; message?: string }> }).errors;
    const first = errors?.[0];
    return first?.longMessage ?? first?.message ?? fallback;
  }
  return fallback;
}
