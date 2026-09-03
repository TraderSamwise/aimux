import type { CoreLogoutTextResult, CoreRemoteStatusTextPayload, CoreWhoamiTextPayload } from "../core-text.js";
import type { CoreRelaySnapshot } from "../core-command-contract.js";
import {
  type DaemonHostedBridge,
  type DaemonRelayBridge,
  type DaemonRemoteFeatures,
  type RemoteAccessContext,
  type RemoteAccessDecision,
} from "../daemon-remote-features.js";
import type { RelayNotificationPush, RelayStatusSnapshot } from "../relay-contract.js";
import type { RemoteActor } from "../remote-actor.js";
import { log } from "../debug.js";
import { setMobilePushForwarder } from "../notify.js";
import { clearCredentials, loadCredentials, setRemoteEnabled } from "./credentials.js";
import { loadHostedConfig, validateHostedStartup } from "./hosted-config.js";
import { countActiveHostedPrincipals } from "./hosted-principals.js";
import { startHostedServer, type HostedServerHandle } from "./hosted-server.js";
import { runLoginFlow } from "./login-flow.js";
import { forwardAlertToMobilePush } from "./mobile-push-bridge.js";
import { MobilePushThrottle } from "./mobile-push-throttle.js";
import { RelayClient } from "./relay-client.js";
import { assertOperatorStreamAllowed, assertRemoteAccessAllowed, parseRemoteActor } from "./remote-access.js";

export function createFullDaemonRemoteFeatures(): DaemonRemoteFeatures {
  let relayClient: RelayClient | null = null;
  let hostedServer: HostedServerHandle | null = null;
  const pushThrottle = new MobilePushThrottle();

  const getRelayStatus = (): RelayStatusSnapshot | { status: "off" } => relayClient?.getStatus() ?? { status: "off" };

  const connectRelay = (bridge: DaemonRelayBridge, options: { force?: boolean } = {}) => {
    const status = relayClient?.getStatus().status;
    if (!options.force && relayClient && status !== "auth_failed" && status !== "disconnected") return;
    if (relayClient) {
      relayClient.disconnect();
      relayClient = null;
    }
    const creds = loadCredentials();
    const relayUrl = process.env.AIMUX_RELAY_URL ?? creds?.relayUrl;
    const relayToken = process.env.AIMUX_RELAY_TOKEN ?? creds?.token;
    const hasEnvOverride = Boolean(process.env.AIMUX_RELAY_URL || process.env.AIMUX_RELAY_TOKEN);
    const enabled = hasEnvOverride ? Boolean(relayUrl && relayToken) : Boolean(creds?.remoteEnabled);
    if (relayUrl && relayToken && enabled) {
      relayClient = new RelayClient(relayUrl, relayToken, bridge);
      relayClient.connect();
    }
  };

  const enableRelay = (bridge: DaemonRelayBridge): CoreRelaySnapshot => {
    setRemoteEnabled(true);
    connectRelay(bridge, { force: true });
    return getRelayStatus();
  };

  return {
    profile: "full",
    async startHostedListener(bridge: DaemonHostedBridge) {
      setMobilePushForwarder(forwardAlertToMobilePush);
      const config = loadHostedConfig();
      if (!config.enabled) return;
      const validation = validateHostedStartup(config, countActiveHostedPrincipals());
      if (!validation.ok) {
        log.warn("hosted listener refused to start", "hosted", { error: validation.error });
        return;
      }
      try {
        hostedServer = await startHostedServer({
          config,
          routeHostedRequest: bridge.routeHostedRequest,
          resolveHostedStream: bridge.resolveHostedStream,
        });
      } catch (error) {
        log.warn("hosted listener failed to bind", "hosted", {
          host: config.bindAddress,
          port: config.port,
          error: error instanceof Error ? error.message : String(error),
        });
        hostedServer = null;
      }
    },
    async stop() {
      const hosted = hostedServer;
      hostedServer = null;
      if (hosted) await hosted.close().catch(() => {});
      relayClient?.disconnect();
      relayClient = null;
      setMobilePushForwarder(null);
    },
    connectRelay,
    getRelayStatus,
    enableRelay,
    enableRelayBestEffort(bridge: DaemonRelayBridge): CoreRelaySnapshot {
      try {
        return enableRelay(bridge);
      } catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        const relay = getRelayStatus();
        if (relay.status === "off") return { status: "disconnected", relayUrl: "", lastConnectedAt: null, lastError };
        return { ...relay, lastError };
      }
    },
    disableRelay() {
      setRemoteEnabled(false);
      relayClient?.disconnect();
      relayClient = null;
      return { status: "off" };
    },
    hasCredentials() {
      return Boolean(loadCredentials());
    },
    remoteStatusTextPayload(): CoreRemoteStatusTextPayload {
      const credentials = loadCredentials();
      return {
        credentials: credentials ? { relayUrl: credentials.relayUrl, remoteEnabled: credentials.remoteEnabled } : null,
        relay: getRelayStatus(),
      };
    },
    whoamiTextPayload(): CoreWhoamiTextPayload {
      const credentials = loadCredentials();
      return {
        credentials: credentials
          ? {
              userId: credentials.userId,
              relayUrl: credentials.relayUrl,
              remoteEnabled: credentials.remoteEnabled,
            }
          : null,
      };
    },
    clearCredentials(): CoreLogoutTextResult {
      return clearCredentials();
    },
    runLoginFlow,
    parseRemoteActor,
    assertRemoteAccessAllowed(
      actor: RemoteActor | null,
      method: string,
      pathname: string,
      searchParams: URLSearchParams,
      context: RemoteAccessContext = {},
    ): RemoteAccessDecision {
      return assertRemoteAccessAllowed(actor, method, pathname, searchParams, context);
    },
    assertOperatorStreamAllowed(
      actor: RemoteActor | null,
      method: string,
      pathname: string,
      searchParams: URLSearchParams,
      context: RemoteAccessContext = {},
    ): RemoteAccessDecision {
      return assertOperatorStreamAllowed(actor, method, pathname, searchParams, context);
    },
    pushNotification(payload: RelayNotificationPush) {
      if (relayClient?.getStatus().status !== "connected") {
        return { ok: true, suppressed: true, reason: "relay_unavailable" };
      }
      if (!pushThrottle.allow(payload)) return { ok: true, suppressed: true };
      relayClient.pushNotification(payload);
      return { ok: true };
    },
  };
}
