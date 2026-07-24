import { Stack, useRouter, useSegments } from "expo-router";
import React, { useEffect } from "react";
import { Platform } from "react-native";
import { useColorScheme } from "nativewind";
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, LOCAL_MODE, useAuth } from "@/lib/auth";
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

  useEffect(() => {
    if (!isLoaded || onCliAuth) return;
    if (isSignedIn && onAuthScreen) {
      router.replace("/");
    } else if (!isSignedIn && !LOCAL_MODE && !onPublicScreen) {
      router.replace("/auth");
    }
  }, [isSignedIn, isLoaded, onAuthScreen, onPublicScreen, onCliAuth, router]);

  if (!isLoaded) return null;
  return <>{children}</>;
}

export default function RootLayout() {
  useThemeEffect();
  const { colorScheme } = useColorScheme();
  const navTheme = colorScheme === "dark" ? DarkTheme : DefaultTheme;

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
      <ThemeProvider value={navTheme}>
        <AuthProvider>
          <AuthGate>
            <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
            <Stack>
              <Stack.Screen name="(main)" options={{ headerShown: false }} />
              <Stack.Screen name="inbox" options={{ headerShown: false }} />
              <Stack.Screen name="auth" options={{ headerShown: false }} />
              <Stack.Screen
                name="shares/invite/[ownerUserId]/[token]/accept"
                options={{ headerShown: false }}
              />
              <Stack.Screen name="cli-auth" options={{ headerShown: false }} />
            </Stack>
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
