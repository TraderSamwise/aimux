const defaultedRuntimeEnvKeys = [];

const optionalRuntimeEnvKeys = [
  "EXPO_PUBLIC_AIMUX_DAEMON_URL",
  "EXPO_PUBLIC_AIMUX_CONNECTION_MODE",
  "EXPO_PUBLIC_AIMUX_RELAY_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  // Optional on purpose: the delivery diagnostics are inert without a DSN and
  // must never be the reason a send looks like it failed. Declared here
  // because `envRuntime.ts` reads all three, and the release env gate -- which
  // caught this -- refuses a key the app uses but the contract does not name.
  "EXPO_PUBLIC_SENTRY_DSN",
  "EXPO_PUBLIC_SENTRY_ENVIRONMENT",
  "EXPO_PUBLIC_SENTRY_RELEASE",
];

const requiredReleaseEnvKeys = ["EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"];
const buildOnlyEnvKeys = [];

const allKnownEnvKeys = Array.from(
  new Set([
    ...defaultedRuntimeEnvKeys,
    ...optionalRuntimeEnvKeys,
    ...requiredReleaseEnvKeys,
    ...buildOnlyEnvKeys,
  ]),
).sort();

module.exports = {
  defaultedRuntimeEnvKeys,
  optionalRuntimeEnvKeys,
  requiredReleaseEnvKeys,
  buildOnlyEnvKeys,
  allKnownEnvKeys,
};
