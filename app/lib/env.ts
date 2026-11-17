/**
 * Validated environment variables.
 * Uses lazy getters so errors are thrown during rendering
 * (catchable by error boundaries) rather than at module evaluation time.
 */

import { rawEnv } from "./envRuntime";
import { sentryDsn, sentryEnvironment, sentryRelease } from "./sentry-config";
import {
  resolveAppConnectionMode,
  resolveAppDaemonUrl,
  resolveAppRelayUrl,
  type AppConnectionMode,
} from "./connection-targets";

export const env = {
  get CLERK_PUBLISHABLE_KEY(): string | undefined {
    return rawEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || undefined;
  },
  get AIMUX_DAEMON_URL(): string | undefined {
    return resolveAppDaemonUrl();
  },
  get AIMUX_RELAY_URL(): string | undefined {
    return resolveAppRelayUrl();
  },
  get AIMUX_CONNECTION_MODE(): AppConnectionMode {
    return resolveAppConnectionMode();
  },
  /**
   * Where delivery diagnostics go. One implementation, in `sentry-config`,
   * because that module is importable without a native runtime and this one
   * is not.
   */
  get SENTRY_DSN(): string | undefined {
    return sentryDsn();
  },
  get SENTRY_ENVIRONMENT(): string {
    return sentryEnvironment();
  },
  get SENTRY_RELEASE(): string | undefined {
    return sentryRelease();
  },
};
