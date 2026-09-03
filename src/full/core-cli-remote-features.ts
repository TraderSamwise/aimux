import type { CoreRelaySnapshot } from "../core-command-contract.js";
import {
  createLocalCoreCliRemoteFeatures,
  type CoreCliRemoteFeatures,
  type CoreLoginResult,
  type CoreLogoutResult,
  type CoreRemoteCredentialsSummary,
} from "../core-cli-remote-features.js";
import type { CoreWhoamiTextPayload } from "../core-text.js";
import { clearCredentials, loadCredentials, setRemoteEnabled } from "./credentials.js";
import { runLoginFlow } from "./login-flow.js";

export function createFullCoreCliRemoteFeatures(): CoreCliRemoteFeatures {
  const local = createLocalCoreCliRemoteFeatures();
  return {
    credentialsForStatus(): CoreRemoteCredentialsSummary | null {
      const creds = loadCredentials();
      return creds ? { relayUrl: creds.relayUrl, remoteEnabled: creds.remoteEnabled } : null;
    },
    whoamiPayload(): CoreWhoamiTextPayload {
      const creds = loadCredentials();
      return {
        credentials: creds
          ? {
              userId: creds.userId,
              relayUrl: creds.relayUrl,
              remoteEnabled: creds.remoteEnabled,
            }
          : null,
      };
    },
    hasCredentials(): boolean {
      return Boolean(loadCredentials());
    },
    setRemoteEnabled(enabled: boolean): void {
      setRemoteEnabled(enabled);
    },
    clearCredentials(): CoreLogoutResult {
      return clearCredentials();
    },
    async runLoginFlow(opts?: { action?: "security-unlock" }): Promise<CoreLoginResult> {
      return runLoginFlow(opts);
    },
    remoteUnavailableRelayStatus(): CoreRelaySnapshot {
      return local.remoteUnavailableRelayStatus();
    },
  };
}
