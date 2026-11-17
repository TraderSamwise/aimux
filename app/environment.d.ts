declare namespace NodeJS {
  interface ProcessEnv {
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?: string;
    EXPO_PUBLIC_AIMUX_DAEMON_URL?: string;
    EXPO_PUBLIC_AIMUX_RELAY_URL?: string;
    EXPO_PUBLIC_AIMUX_CONNECTION_MODE?: "local" | "relay";
    EXPO_PUBLIC_SENTRY_DSN?: string;
    EXPO_PUBLIC_SENTRY_ENVIRONMENT?: string;
    EXPO_PUBLIC_SENTRY_RELEASE?: string;
  }
}
