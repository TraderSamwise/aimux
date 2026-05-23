import React, { createContext, useContext } from "react";
import { ClerkProvider, useAuth as useClerkAuth, useUser as useClerkUser } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";

import { env } from "@/lib/env";

export interface AuthState {
  isSignedIn: boolean;
  isLoaded: boolean;
  userId: string | null;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

export function assertAuthConfiguredForConnectionMode(): void {
  if (env.AIMUX_CONNECTION_MODE === "relay" && !env.CLERK_PUBLISHABLE_KEY) {
    throw new Error("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is required when aimux is in relay mode.");
  }
}

/** true when no Clerk key is configured and the app is using local daemon HTTP */
export const LOCAL_MODE = env.AIMUX_CONNECTION_MODE === "local" && !env.CLERK_PUBLISHABLE_KEY;

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
  assertAuthConfiguredForConnectionMode();

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
