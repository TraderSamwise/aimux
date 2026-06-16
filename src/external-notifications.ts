export function externalNotificationsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS === "1" || env.AIMUX_DISABLE_DESKTOP_NOTIFICATIONS === "1";
}
