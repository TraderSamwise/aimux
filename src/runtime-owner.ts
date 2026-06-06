import { getGlobalAimuxDir } from "./paths.js";

const DEFAULT_DAEMON_PORT = "43190";

export const TMUX_RUNTIME_OWNER_OPTION = "@aimux-runtime-owner";
export const TMUX_DASHBOARD_OWNER_OPTION = "@aimux-dashboard-owner";

export function getRuntimeOwnerId(): string {
  return JSON.stringify({
    home: getGlobalAimuxDir(),
    port: process.env.AIMUX_DAEMON_PORT?.trim() || DEFAULT_DAEMON_PORT,
  });
}
