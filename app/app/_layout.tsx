import { Stack, useRouter, useSegments } from "expo-router";
import React, { useEffect } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";

import "../global.css";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const onAuthScreen = segments[0] === "sign-in" || segments[0] === "sign-up";

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && onAuthScreen) {
      router.replace("/");
    }
  }, [isSignedIn, isLoaded, onAuthScreen, router]);

  if (!isLoaded) return null;
  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AuthGate>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(main)" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ headerShown: false, presentation: "modal" }} />
          <Stack.Screen name="sign-up" options={{ headerShown: false, presentation: "modal" }} />
        </Stack>
      </AuthGate>
    </AuthProvider>
  );
}
