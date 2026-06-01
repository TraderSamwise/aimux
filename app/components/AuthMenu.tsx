import React, { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { LOCAL_MODE, useAuth, useUser } from "@/lib/auth";
import { useMainTabNavigation } from "@/lib/main-tabs";
import { APP_VERSION, getVersionString } from "@/lib/version";

function initialsFromUser(user: ReturnType<typeof useUser>["user"]): string {
  if (!user) return "?";
  const first = user.firstName?.[0] ?? "";
  const last = user.lastName?.[0] ?? "";
  if (first || last) return `${first}${last}`.toUpperCase();
  const email = user.emailAddresses?.[0]?.emailAddress;
  return (email?.[0] ?? "?").toUpperCase();
}

export function AuthMenu() {
  const router = useRouter();
  const navigateTab = useMainTabNavigation();
  const { isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  const [open, setOpen] = useState(false);

  if (LOCAL_MODE) {
    return <Badge variant="secondary" label="Local" />;
  }

  if (!isSignedIn) {
    return (
      <Button variant="outline" size="sm" label="Sign in" onPress={() => router.push("/auth")} />
    );
  }

  const close = () => setOpen(false);

  const versionLabel = `Version ${getVersionString()}`;
  const buildLabel = `Build ${APP_VERSION.buildNumber} · OTA ${APP_VERSION.otaVersion}`;

  const menu = (
    <Card className="w-56 p-1">
      <Pressable
        className="flex-row items-center rounded-md px-3 py-2 active:bg-accent"
        onPress={() => {
          close();
          navigateTab("settings");
        }}
      >
        <Text className="text-sm text-foreground">Settings</Text>
      </Pressable>
      <Pressable
        className="flex-row items-center rounded-md px-3 py-2 active:bg-accent"
        onPress={() => {
          close();
          void signOut().then(() => router.replace("/auth"));
        }}
      >
        <Text className="text-sm text-destructive">Sign out</Text>
      </Pressable>
      <View className="mt-1 border-t border-border px-3 py-2">
        <Text className="text-xs text-muted-foreground">{versionLabel}</Text>
        <Text className="mt-0.5 text-xs text-muted-foreground">{buildLabel}</Text>
      </View>
    </Card>
  );

  return (
    <View className="relative">
      <Pressable
        className="h-8 w-8 items-center justify-center rounded-full bg-secondary"
        onPress={() => setOpen((v) => !v)}
      >
        <Text className="text-xs font-semibold text-secondary-foreground">
          {initialsFromUser(user)}
        </Text>
      </Pressable>

      {open ? (
        Platform.OS === "web" ? (
          <>
            <Pressable
              onPress={close}
              style={
                { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 40 } as object
              }
            />
            <View className="absolute right-0 top-full z-50 mt-2">{menu}</View>
          </>
        ) : (
          <Modal transparent visible animationType="none" onRequestClose={close}>
            <Pressable onPress={close} style={StyleSheet.absoluteFill} />
            <View style={{ position: "absolute", top: 56, right: 12 }}>{menu}</View>
          </Modal>
        )
      ) : null}
    </View>
  );
}
