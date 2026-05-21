const defaultedRuntimeEnvKeys = [];

const optionalRuntimeEnvKeys = [
  "EXPO_PUBLIC_AIMUX_DAEMON_URL",
  "EXPO_PUBLIC_AIMUX_RELAY_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
];

const requiredReleaseEnvKeys = [];
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
