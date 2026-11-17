/**
 * Where delivery diagnostics go.
 *
 * Deliberately reads `rawEnv` rather than `@/lib/env`: that module pulls in
 * `connection-targets`, which imports `react-native`, which the unit tests
 * cannot parse. Diagnostics have to stay testable without a native runtime --
 * they are the thing that tells us whether an error is real.
 */

import { rawEnv } from "./envRuntime";

/** Unset means diagnostics stay in the console, as they did before Sentry. */
export function sentryDsn(): string | undefined {
  return rawEnv.EXPO_PUBLIC_SENTRY_DSN || undefined;
}

export function sentryEnvironment(): string {
  const configured = rawEnv.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
  if (configured) return configured;
  return rawEnv.NODE_ENV === "production" ? "production" : "development";
}

export function sentryRelease(): string | undefined {
  return rawEnv.EXPO_PUBLIC_SENTRY_RELEASE || undefined;
}
