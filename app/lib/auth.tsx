import React, { createContext, useContext } from "react";
import { ClerkProvider, useAuth as useClerkAuth, useUser as useClerkUser } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { StyleSheet, Text, View } from "react-native";

import { env } from "@/lib/env";

export interface AuthState {
  isSignedIn: boolean;
  isLoaded: boolean;
  userId: string | null;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

export function assertAuthConfiguredForConnectionMode(): void {
  const error = getAuthConfigurationError();
  if (error) throw new Error(error);
}

export function getAuthConfigurationError(): string | null {
  if (env.AIMUX_CONNECTION_MODE === "relay" && !env.CLERK_PUBLISHABLE_KEY) {
    return "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is required when aimux is in relay mode.";
  }
  return null;
}

/** true when the app is using local daemon HTTP */
export const LOCAL_MODE = env.AIMUX_CONNECTION_MODE === "local";

const noop = async () => {};
const noopToken = async () => null;

// Local-mode context: always signed in as "local" user
const LocalAuthContext = createContext<AuthState>({
  isSignedIn: true,
  isLoaded: true,
  userId: "local",
  signOut: noop,
  getToken: noopToken,
});

function useLocalAuth(): AuthState {
  return useContext(LocalAuthContext);
}

function useClerkAuthAdapter(): AuthState {
  const { isSignedIn, isLoaded, userId, signOut, getToken } = useClerkAuth();
  return {
    isSignedIn: isSignedIn ?? false,
    isLoaded: isLoaded ?? false,
    userId: userId ?? null,
    signOut: async () => {
      await signOut();
    },
    getToken: async () => getToken() ?? null,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const configurationError = getAuthConfigurationError();
  if (configurationError) {
    return <AuthConfigurationError message={configurationError} />;
  }

  if (LOCAL_MODE) {
    return (
      <LocalAuthContext.Provider
        value={{
          isSignedIn: true,
          isLoaded: true,
          userId: "local",
          signOut: noop,
          getToken: noopToken,
        }}
      >
        {children}
      </LocalAuthContext.Provider>
    );
  }

  return (
    <ClerkProvider publishableKey={env.CLERK_PUBLISHABLE_KEY!} tokenCache={tokenCache}>
      {children}
    </ClerkProvider>
  );
}

function AuthConfigurationError({ message }: { message: string }) {
  return (
    <View style={styles.configErrorShell}>
      <View style={styles.configErrorCard}>
        <Text style={styles.configErrorTitle}>Aimux cannot start</Text>
        <Text style={styles.configErrorBody}>{message}</Text>
      </View>
    </View>
  );
}

/* eslint-disable react-hooks/rules-of-hooks -- LOCAL_MODE is a build-time constant */
export function useAuth(): AuthState {
  assertAuthConfiguredForConnectionMode();

  if (LOCAL_MODE) {
    return useLocalAuth();
  }
  return useClerkAuthAdapter();
}

/** Safe useUser — returns { user: null } when Clerk is absent or user is not signed in. */
export function useUser() {
  assertAuthConfiguredForConnectionMode();

  if (LOCAL_MODE) return { user: null };
  const { user } = useClerkUser();
  return { user: user ?? null };
}
/* eslint-enable react-hooks/rules-of-hooks */

const styles = StyleSheet.create({
  configErrorBody: {
    color: "#cbd5e1",
    fontSize: 15,
    lineHeight: 22,
  },
  configErrorCard: {
    backgroundColor: "#111827",
    borderColor: "#7f1d1d",
    borderRadius: 10,
    borderWidth: 1,
    maxWidth: 420,
    padding: 18,
  },
  configErrorShell: {
    alignItems: "center",
    backgroundColor: "#020617",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  configErrorTitle: {
    color: "#fecaca",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
});
