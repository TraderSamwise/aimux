import { getGlobalAimuxDir } from "./paths.js";

const DEFAULT_DAEMON_PORT = "43190";

export const TMUX_RUNTIME_OWNER_OPTION = "@aimux-runtime-owner";
export const TMUX_DASHBOARD_OWNER_OPTION = "@aimux-dashboard-owner";
export const TMUX_DASHBOARD_READY_OPTION = "@aimux-dashboard-ready";
export const TMUX_RUNTIME_CONTRACT_OPTION = "@aimux-runtime-contract";
export const TMUX_RUNTIME_REBUILD_REQUIRED_OPTION = "@aimux-runtime-rebuild-required";
export const AIMUX_TMUX_RUNTIME_CONTRACT_VERSION = "1";

export function getRuntimeOwnerId(): string {
  return JSON.stringify({
    home: getGlobalAimuxDir(),
    port: process.env.AIMUX_DAEMON_PORT?.trim() || DEFAULT_DAEMON_PORT,
  });
}
