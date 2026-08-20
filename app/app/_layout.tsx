import { Stack, useGlobalSearchParams, useRouter, useSegments } from "expo-router";
import React, { useEffect } from "react";
import { Platform } from "react-native";
import { useColorScheme } from "nativewind";
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AuthProvider, LOCAL_MODE, useAuth } from "@/lib/auth";
import { sanitizeRedirect } from "@/lib/clerk-errors";
import { singleRouteParam } from "@/lib/route-params";
import { useAppStackScreenOptions } from "@/lib/navigation";
import { useThemeEffect } from "@/lib/theme-effect";

import "../global.css";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const onAuthScreen = segments[0] === "auth";
  const onPublicScreen = onAuthScreen || segments[0] === "shares";
  // cli-auth manages its own signed-in/out states — never auto-redirect it.
  const onCliAuth = segments[0] === "cli-auth";
  // Where sign-in was headed before it was interrupted — an invite link, say.
  // Clerk flipping isSignedIn used to race the auth screen's own navigation and
  // land everyone on "/", which silently dropped the invite they clicked.
  const params = useGlobalSearchParams<{ redirect?: string | string[] }>();
  const pendingRedirect = sanitizeRedirect(singleRouteParam(params.redirect));

  useEffect(() => {
    if (!isLoaded || onCliAuth) return;
    if (isSignedIn && onAuthScreen) {
      router.replace(pendingRedirect ?? "/");
    } else if (!isSignedIn && !LOCAL_MODE && !onPublicScreen) {
      router.replace("/auth");
    }
  }, [isSignedIn, isLoaded, onAuthScreen, onPublicScreen, onCliAuth, pendingRedirect, router]);

  if (!isLoaded) return null;
  return <>{children}</>;
}

export default function RootLayout() {
  useThemeEffect();
  const { colorScheme } = useColorScheme();
  const navTheme = colorScheme === "dark" ? DarkTheme : DefaultTheme;
  const stackScreenOptions = useAppStackScreenOptions();

  useEffect(() => {
    if (Platform.OS !== "web") return;
    document.title = "aimux - local AI agent multiplexer";
    const description =
      "Run Claude, Codex, Aider, and shell sessions in tmux with one local control plane for terminal, web, and mobile.";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.content = description;
  }, []);

  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <ThemeProvider value={navTheme}>
          <AuthProvider>
            <AuthGate>
              <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
              <Stack screenOptions={stackScreenOptions}>
                <Stack.Screen name="(main)" />
                <Stack.Screen name="inbox" />
                <Stack.Screen name="auth" />
                <Stack.Screen name="shares/invite/[ownerUserId]/[token]/accept" />
                <Stack.Screen name="cli-auth" />
              </Stack>
            </AuthGate>
          </AuthProvider>
        </ThemeProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
