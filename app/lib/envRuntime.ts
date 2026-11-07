type AimuxLocalConfig = {
  connectionMode?: string;
  daemonUrl?: string;
  relayUrl?: string;
};

declare global {
  interface Window {
    __AIMUX_LOCAL_CONFIG__?: AimuxLocalConfig;
  }
}

function runtimeConfig(): AimuxLocalConfig | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__AIMUX_LOCAL_CONFIG__;
}

export const rawEnv = {
  get EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY(): string | undefined {
    return process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  },
  get EXPO_PUBLIC_AIMUX_DAEMON_URL(): string | undefined {
    return runtimeConfig()?.daemonUrl ?? process.env.EXPO_PUBLIC_AIMUX_DAEMON_URL;
  },
  get EXPO_PUBLIC_AIMUX_RELAY_URL(): string | undefined {
    return runtimeConfig()?.relayUrl ?? process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;
  },
  get EXPO_PUBLIC_AIMUX_CONNECTION_MODE(): string | undefined {
    return runtimeConfig()?.connectionMode ?? process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
  },
  get EXPO_PUBLIC_SENTRY_DSN(): string | undefined {
    return process.env.EXPO_PUBLIC_SENTRY_DSN;
  },
  get EXPO_PUBLIC_SENTRY_ENVIRONMENT(): string | undefined {
    return process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
  },
  get EXPO_PUBLIC_SENTRY_RELEASE(): string | undefined {
    return process.env.EXPO_PUBLIC_SENTRY_RELEASE;
  },
  get NODE_ENV(): string | undefined {
    return process.env.NODE_ENV;
  },
};
