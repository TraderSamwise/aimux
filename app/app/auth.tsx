import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import { useSignIn, useSignUp } from "@clerk/clerk-expo";
import { useLocalSearchParams, useRouter } from "expo-router";
import { BrandPanel } from "@/components/auth/BrandPanel";
import { EmailPasswordForm } from "@/components/auth/EmailPasswordForm";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { OAuthRow } from "@/components/auth/OAuthRow";
import { VerificationForm } from "@/components/auth/VerificationForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { clerkErrorMessage, sanitizeRedirect } from "@/lib/clerk-errors";

type AuthMode = "sign-in" | "sign-up";
type Phase = "form" | "verify" | "forgot" | "forgot-verify";

const SIDE_PANEL_MIN_WIDTH = 880;

export default function AuthScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string | string[]; redirect?: string | string[] }>();
  const { width } = useWindowDimensions();

  const initialMode = readFirstParam(params.mode) === "sign-up" ? "sign-up" : "sign-in";
  const redirect = sanitizeRedirect(readFirstParam(params.redirect));

  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [phase, setPhase] = useState<Phase>("form");
  const [pendingEmail, setPendingEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const showSidePanel = Platform.OS === "web" && width >= SIDE_PANEL_MIN_WIDTH;

  const { signIn, setActive: setActiveSignIn, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setActiveSignUp, isLoaded: signUpLoaded } = useSignUp();

  const isLoaded = signInLoaded && signUpLoaded;

  function reset() {
    setError("");
    setNewPassword("");
  }

  function switchMode(next: AuthMode) {
    if (loading) return;
    setMode(next);
    setPhase("form");
    reset();
  }

  async function handleSignIn({ email, password }: { email: string; password: string }) {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === "complete") {
        await setActiveSignIn({ session: result.createdSessionId });
        router.replace(redirect ?? "/");
      } else if (
        result.status === "needs_second_factor" ||
        (result.status as string) === "needs_client_trust"
      ) {
        await signIn.prepareSecondFactor({ strategy: "email_code" });
        setPendingEmail(email);
        setPhase("verify");
      } else {
        setError(`Sign in requires additional steps: ${result.status}`);
      }
    } catch (err) {
      setError(clerkErrorMessage(err, "Sign in failed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUp({ email, password }: { email: string; password: string }) {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      await signUp.create({ emailAddress: email, password });
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setPendingEmail(email);
      setPhase("verify");
    } catch (err) {
      setError(clerkErrorMessage(err, "Sign up failed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(code: string) {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      if (mode === "sign-in") {
        const result = await signIn.attemptSecondFactor({ strategy: "email_code", code });
        if (result.status === "complete") {
          await setActiveSignIn({ session: result.createdSessionId });
          router.replace(redirect ?? "/");
        } else {
          setError(`Verification incomplete: ${result.status}`);
        }
      } else {
        const result = await signUp.attemptEmailAddressVerification({ code });
        if (result.status === "complete") {
          await setActiveSignUp({ session: result.createdSessionId });
          router.replace(redirect ?? "/");
        } else {
          setError(`Verification incomplete: ${result.status}`);
        }
      }
    } catch (err) {
      setError(clerkErrorMessage(err, "Verification failed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResendVerify() {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      if (mode === "sign-in") {
        await signIn.prepareSecondFactor({ strategy: "email_code" });
      } else {
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      }
    } catch (err) {
      setError(clerkErrorMessage(err, "Failed to resend code"));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotStart(email: string) {
    if (!isLoaded) return;
    setError("");
    setLoading(true);
    try {
      await signIn.create({
        strategy: "reset_password_email_code",
        identifier: email,
      });
      setPendingEmail(email);
      setPhase("forgot-verify");
    } catch (err) {
      setError(clerkErrorMessage(err, "Could not start password reset"));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotVerify(code: string) {
    if (!isLoaded) return;
    setError("");
    if (!newPassword || newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code,
        password: newPassword,
      });
      if (result.status === "complete") {
        await setActiveSignIn({ session: result.createdSessionId });
        router.replace(redirect ?? "/");
      } else {
        setError(`Reset incomplete: ${result.status}`);
      }
    } catch (err) {
      setError(clerkErrorMessage(err, "Password reset failed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResendForgot() {
    if (!isLoaded || !pendingEmail) return;
    setError("");
    setLoading(true);
    try {
      await signIn.create({
        strategy: "reset_password_email_code",
        identifier: pendingEmail,
      });
    } catch (err) {
      setError(clerkErrorMessage(err, "Failed to resend code"));
    } finally {
      setLoading(false);
    }
  }

  const card = (() => {
    if (phase === "verify") {
      return (
        <VerificationForm
          email={pendingEmail}
          loading={loading}
          error={error}
          submitLabel={mode === "sign-up" ? "Verify email" : "Verify"}
          onSubmit={handleVerify}
          onResend={handleResendVerify}
          onBack={() => {
            setPhase("form");
            reset();
          }}
        />
      );
    }

    if (phase === "forgot") {
      return (
        <ForgotPasswordForm
          loading={loading}
          error={error}
          onSubmit={handleForgotStart}
          onBack={() => {
            setPhase("form");
            reset();
          }}
        />
      );
    }

    if (phase === "forgot-verify") {
      return (
        <VerificationForm
          email={pendingEmail}
          loading={loading}
          error={error}
          submitLabel="Reset password"
          onSubmit={handleForgotVerify}
          onResend={handleResendForgot}
          onBack={() => {
            setPhase("forgot");
            reset();
          }}
          extra={
            <View>
              <Text className="text-[12px] font-medium text-muted-foreground mb-1.5">
                New password
              </Text>
              <Input
                placeholder="At least 8 characters"
                placeholderTextColor="hsl(var(--muted-foreground))"
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
              />
            </View>
          }
        />
      );
    }

    return (
      <View>
        <SegmentedControl
          fullWidth
          options={[
            { value: "sign-in", label: "Sign in" },
            { value: "sign-up", label: "Sign up" },
          ]}
          value={mode}
          onChange={switchMode}
        />

        <View className="mt-6">
          <OAuthRow />
        </View>

        <View className="flex-row items-center my-5">
          <View className="flex-1 h-px bg-border" />
          <Text className="mx-3 text-[11px] uppercase tracking-wider text-muted-foreground">
            or email
          </Text>
          <View className="flex-1 h-px bg-border" />
        </View>

        <EmailPasswordForm
          mode={mode}
          loading={loading}
          error={error}
          onSubmit={mode === "sign-in" ? handleSignIn : handleSignUp}
          onForgotPassword={() => {
            setPhase("forgot");
            reset();
          }}
        />

        {mode === "sign-up" ? (
          <Text className="text-[11px] text-muted-foreground text-center mt-5 leading-snug">
            By creating an account you agree to receive transactional email related to your aimux
            sessions.
          </Text>
        ) : null}
      </View>
    );
  })();

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View className="flex-1 flex-row">
        {showSidePanel ? <BrandPanel variant="side" /> : null}

        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow justify-center items-center px-6 py-12"
          keyboardShouldPersistTaps="handled"
        >
          <View className="w-full max-w-[400px]">
            {!showSidePanel ? <BrandPanel variant="compact" /> : null}

            <View className="rounded-2xl border border-border bg-card p-6">{card}</View>

            {phase === "form" ? (
              <Button
                className="mt-4"
                variant="ghost"
                label={
                  mode === "sign-in" ? "Don’t have an account? Sign up" : "Have an account? Sign in"
                }
                onPress={() => switchMode(mode === "sign-in" ? "sign-up" : "sign-in")}
                disabled={loading}
              />
            ) : null}
          </View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

function readFirstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
