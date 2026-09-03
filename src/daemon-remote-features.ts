import type {
  CoreLoginTextPayload,
  CoreLogoutTextResult,
  CoreRemoteStatusTextPayload,
  CoreWhoamiTextPayload,
} from "./core-text.js";
import type { CoreRelaySnapshot } from "./core-command-contract.js";
import { parseRemoteActor, type RemoteActor } from "./remote-actor.js";
import type { RelayNotificationPush } from "./relay-contract.js";

export interface DaemonRouteResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

export interface RemoteAccessContext {
  body?: unknown;
  projectRoot?: string | null;
}

export interface RemoteAccessDecision {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DaemonHostedBridge {
  routeHostedRequest: (
    actor: RemoteActor,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<DaemonRouteResponse>;
  resolveHostedStream: (
    actor: RemoteActor,
    method: string,
    path: string,
  ) => { ok: true; url: string; projectRoot: string } | { ok: false; status: number; error: string };
}

export interface DaemonRelayBridge {
  routeRequest(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<DaemonRouteResponse>;
  resolveProjectEventStream(
    path: string,
    headers?: Record<string, string>,
  ): { ok: true; url: string; headers?: Record<string, string> } | { ok: false; status: number; error: string };
}

export interface DaemonRemoteFeatures {
  readonly profile: "local" | "full";
  startHostedListener(bridge: DaemonHostedBridge): Promise<void>;
  stop(): Promise<void>;
  connectRelay(bridge: DaemonRelayBridge, options?: { force?: boolean }): void;
  getRelayStatus(): CoreRelaySnapshot;
  enableRelay(bridge: DaemonRelayBridge): CoreRelaySnapshot;
  enableRelayBestEffort(bridge: DaemonRelayBridge): CoreRelaySnapshot;
  disableRelay(): { status: "off" };
  hasCredentials(): boolean;
  remoteStatusTextPayload(): CoreRemoteStatusTextPayload;
  whoamiTextPayload(): CoreWhoamiTextPayload;
  clearCredentials(): CoreLogoutTextResult;
  runLoginFlow(input: {
    action?: "security-unlock";
    onMessage?: (message: string) => void;
  }): Promise<{ userId: string }>;
  parseRemoteActor(headers: Record<string, string> | undefined): RemoteActor | null;
  assertRemoteAccessAllowed(
    actor: RemoteActor | null,
    method: string,
    pathname: string,
    searchParams: URLSearchParams,
    context?: RemoteAccessContext,
  ): RemoteAccessDecision;
  assertOperatorStreamAllowed(
    actor: RemoteActor | null,
    method: string,
    pathname: string,
    searchParams: URLSearchParams,
    context?: RemoteAccessContext,
  ): RemoteAccessDecision;
  pushNotification(payload: RelayNotificationPush): { ok: true; suppressed?: boolean; reason?: string };
}

const LOCAL_RELAY_OFF: CoreRelaySnapshot = { status: "off" };

function localRemoteDenied(): RemoteAccessDecision {
  return { ok: false, status: 403, error: "remote access is unavailable in the local build" };
}

export function createLocalDaemonRemoteFeatures(): DaemonRemoteFeatures {
  return {
    profile: "local",
    async startHostedListener() {},
    async stop() {},
    connectRelay() {},
    getRelayStatus() {
      return LOCAL_RELAY_OFF;
    },
    enableRelay() {
      return LOCAL_RELAY_OFF;
    },
    enableRelayBestEffort() {
      return LOCAL_RELAY_OFF;
    },
    disableRelay() {
      return { status: "off" };
    },
    hasCredentials() {
      return false;
    },
    remoteStatusTextPayload() {
      return { credentials: null, relay: LOCAL_RELAY_OFF };
    },
    whoamiTextPayload() {
      return { credentials: null };
    },
    clearCredentials() {
      return "none";
    },
    async runLoginFlow() {
      throw new Error("remote access is unavailable in the local build");
    },
    parseRemoteActor,
    assertRemoteAccessAllowed(actor) {
      return actor ? localRemoteDenied() : { ok: true };
    },
    assertOperatorStreamAllowed() {
      return localRemoteDenied();
    },
    pushNotification() {
      return { ok: true, suppressed: true, reason: "local_build" };
    },
  };
}
