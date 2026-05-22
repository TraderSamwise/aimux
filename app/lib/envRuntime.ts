export const rawEnv = {
  get EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY(): string | undefined {
    return process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  },
  get EXPO_PUBLIC_AIMUX_DAEMON_URL(): string | undefined {
    return process.env.EXPO_PUBLIC_AIMUX_DAEMON_URL;
  },
  get EXPO_PUBLIC_AIMUX_RELAY_URL(): string | undefined {
    return process.env.EXPO_PUBLIC_AIMUX_RELAY_URL;
  },
  get EXPO_PUBLIC_AIMUX_CONNECTION_MODE(): string | undefined {
    return process.env.EXPO_PUBLIC_AIMUX_CONNECTION_MODE;
  },
  get NODE_ENV(): string | undefined {
    return process.env.NODE_ENV;
  },
};
