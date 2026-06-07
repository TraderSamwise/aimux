// Stored CLI credentials for relay access (`~/.aimux/auth.json`).
//
// Populated by `aimux login` (browser flow). The daemon reads this to connect
// to the relay. The token is a long-lived relay-signed JWT — not a Clerk
// session token — so it survives daemon restarts and runs for ~90 days.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { atomicWrite } from "./atomic-write.js";
import { getAuthPath } from "./paths.js";

export interface AimuxCredentials {
  version: 1;
  relayUrl: string;
  token: string;
  userId: string;
  createdAt: string;
  // When false, the daemon won't connect even if credentials exist.
  // Toggled by `aimux remote enable/disable`.
  remoteEnabled: boolean;
}

export function loadCredentials(): AimuxCredentials | null {
  const path = getAuthPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as AimuxCredentials;
    if (parsed.version !== 1 || !parsed.token || !parsed.relayUrl) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: AimuxCredentials): void {
  atomicWrite(getAuthPath(), `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}

export function clearCredentials(): "cleared" | "none" | "failed" {
  const path = getAuthPath();
  if (!existsSync(path)) return "none";
  try {
    rmSync(path, { force: true });
  } catch {
    return "failed";
  }
  return "cleared";
}

export function setRemoteEnabled(enabled: boolean): AimuxCredentials | null {
  const creds = loadCredentials();
  if (!creds) return null;
  const next = { ...creds, remoteEnabled: enabled };
  saveCredentials(next);
  return next;
}
