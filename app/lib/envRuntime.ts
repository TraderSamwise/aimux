export const rawEnv = {
  get EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY(): string | undefined {
    return process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  },
  get EXPO_PUBLIC_AIMUX_DAEMON_URL(): string | undefined {
    return process.env.EXPO_PUBLIC_AIMUX_DAEMON_URL;
  },
};
