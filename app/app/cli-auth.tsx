import React, { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { LOCAL_MODE, useAuth } from "@/lib/auth";
import { env } from "@/lib/env";

// CLI login bridge. `aimux login` opens this page with a ?callback=<localhost>
// param. Once the user is signed in, we ask the relay to mint a long-lived
// daemon token, then redirect the browser to the localhost callback so the CLI
// can capture it. Web-only — the CLI flow never runs on native.

type Phase = "checking" | "need-signin" | "issuing" | "error" | "invalid-callback" | "done";
const TOKEN_ISSUE_TIMEOUT_MS = 15_000;

function relayHttpBase(): string | null {
  const ws = env.AIMUX_RELAY_URL;
  if (!ws) return null;
  return ws.replace(/^ws/, "http").replace(/\/$/, "");
}

// Daemon tokens are powerful — we must not redirect them anywhere except a
// localhost loopback callback server spun up by the local `aimux login` CLI.
function isAllowedCallback(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  // URL.hostname strips the brackets from IPv6 literals, so the loopback
  // comparison is against "::1", not "[::1]".
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1")
    return false;
  if (url.pathname !== "/callback") return false;
  return true;
}

export default function CliAuthScreen() {
  const params = useLocalSearchParams<{ callback?: string; state?: string; action?: string }>();
  const callback = typeof params.callback === "string" ? params.callback : null;
  const loginState = typeof params.state === "string" ? params.state : null;
  const unlockSecurity = params.action === "security-unlock";
  const { isSignedIn, isLoaded, getToken, userId } = useAuth();
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string>("");

  let blockingPhase: Phase | null = null;
  let blockingError = "";
  let shouldRedirectBlockingError = false;
  if (!callback) {
    blockingPhase = "error";
    blockingError = "Missing callback parameter";
  } else if (!isAllowedCallback(callback)) {
    blockingPhase = "invalid-callback";
    blockingError = "Refusing to authorize: callback is not a localhost loopback URL.";
  } else if (LOCAL_MODE) {
    blockingPhase = "error";
    blockingError = "This deployment runs in local mode — no remote login needed.";
    shouldRedirectBlockingError = true;
  }

  const effectivePhase = !isLoaded
    ? phase
    : (blockingPhase ?? (!isSignedIn ? "need-signin" : phase));
  const effectiveError = blockingError || error;

  function redirectToCallback(qs: string) {
    if (!callback) return;
    const sep = callback.includes("?") ? "&" : "?";
    if (Platform.OS === "web") {
      window.location.href = `${callback}${sep}${qs}`;
    }
  }

  useEffect(() => {
    if (!isLoaded) return;
    if (blockingPhase) {
      if (!shouldRedirectBlockingError) return;
      redirectToCallback(
        `error=${encodeURIComponent(blockingError)}&state=${encodeURIComponent(loginState ?? "")}`,
      );
      return;
    }
    if (!isSignedIn) {
      return;
    }

    let cancelled = false;
    (async () => {
      setPhase("issuing");
      try {
        const base = relayHttpBase();
        if (!base) throw new Error("Relay URL not configured");
        const token = await getToken();
        if (!token) throw new Error("Could not get session token");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TOKEN_ISSUE_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(`${base}/cli/issue-token`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ unlockSecurity }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        const data = (await res.json()) as { ok?: boolean; token?: string; error?: string };
        if (!res.ok || !data.ok || !data.token) {
          throw new Error(data.error ?? `Token issuance failed (${res.status})`);
        }
        if (cancelled) return;
        setPhase("done");
        redirectToCallback(
          `token=${encodeURIComponent(data.token)}&userId=${encodeURIComponent(userId ?? "")}&state=${encodeURIComponent(loginState ?? "")}`,
        );
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setPhase("error");
        redirectToCallback(
          `error=${encodeURIComponent(msg)}&state=${encodeURIComponent(loginState ?? "")}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, callback, blockingPhase, blockingError, shouldRedirectBlockingError]);

  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <View className="max-w-[420px] w-full items-center">
        <Text className="font-mono text-[28px] font-bold text-foreground mb-6">aimux</Text>

        {effectivePhase === "checking" || effectivePhase === "issuing" ? (
          <>
            <ActivityIndicator />
            <Text className="text-[14px] text-muted-foreground mt-4">
              {effectivePhase === "issuing" ? "Authorizing CLI..." : "Checking session..."}
            </Text>
          </>
        ) : null}

        {effectivePhase === "need-signin" ? (
          <>
            <Text className="text-[15px] text-foreground text-center mb-2">
              Sign in to authorize the CLI
            </Text>
            <Text className="text-[13px] text-muted-foreground text-center mb-6">
              After signing in, return to this page to complete login.
            </Text>
            <View className="w-full max-w-[280px]">
              <Button
                label="Sign in"
                onPress={() => {
                  if (Platform.OS === "web") {
                    const here = window.location.pathname + window.location.search;
                    window.location.href = `/auth?mode=sign-in&redirect=${encodeURIComponent(here)}`;
                  }
                }}
              />
            </View>
          </>
        ) : null}

        {effectivePhase === "done" ? (
          <Text className="text-[15px] text-foreground text-center">
            ✓ CLI authorized. Return to your terminal.
          </Text>
        ) : null}

        {effectivePhase === "error" || effectivePhase === "invalid-callback" ? (
          <Text className="text-[14px] text-destructive text-center">{effectiveError}</Text>
        ) : null}
      </View>
    </View>
  );
}
