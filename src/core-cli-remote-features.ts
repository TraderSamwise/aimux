import type { CoreRelaySnapshot } from "./core-command-contract.js";
import type { CoreWhoamiTextPayload } from "./core-text.js";

export interface CoreRemoteCredentialsSummary {
  relayUrl: string;
  remoteEnabled: boolean;
}

export type CoreLogoutResult = "cleared" | "none" | "failed";

export interface CoreLoginResult {
  userId: string;
}

export interface CoreCliRemoteFeatures {
  credentialsForStatus(): CoreRemoteCredentialsSummary | null;
  whoamiPayload(): CoreWhoamiTextPayload;
  hasCredentials(): boolean;
  setRemoteEnabled(enabled: boolean): void;
  clearCredentials(): CoreLogoutResult;
  runLoginFlow(opts?: { action?: "security-unlock" }): Promise<CoreLoginResult>;
  remoteUnavailableRelayStatus(): CoreRelaySnapshot;
}

export function createLocalCoreCliRemoteFeatures(): CoreCliRemoteFeatures {
  const unavailable = "remote access is unavailable in the local build";
  return {
    credentialsForStatus: () => null,
    whoamiPayload: () => ({ credentials: null }),
    hasCredentials: () => false,
    setRemoteEnabled: () => undefined,
    clearCredentials: () => "none",
    runLoginFlow: async () => {
      throw new Error(unavailable);
    },
    remoteUnavailableRelayStatus: () => ({
      status: "disconnected",
      relayUrl: "",
      lastConnectedAt: null,
      lastError: unavailable,
    }),
  };
}
