import { realpathSync } from "node:fs";
import { requestJson } from "../http-client.js";
import { loadMetadataEndpoint } from "../metadata-store.js";
import { getProjectStateDirFor } from "../paths.js";
import {
  AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
  TMUX_RUNTIME_CONTRACT_OPTION,
  TMUX_RUNTIME_REBUILD_REQUIRED_OPTION,
} from "../runtime-owner.js";
import { TmuxRuntimeManager } from "../tmux/runtime-manager.js";
import { isTmuxClientSessionForHost } from "../tmux/session-names.js";
import {
  getProjectServiceManifest,
  hasProjectServiceBuildDrift,
  manifestsMatch,
  type ProjectServiceManifest,
} from "../project-service-manifest.js";

// A dead/wedged service must not stall the dashboard loop, so the health probe is bounded.
const HEALTH_TIMEOUT_MS = 2500;

function sameFilesystemPath(a: string | null, b: string): boolean {
  if (!a) return false;
  const normalize = (value: string) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  return normalize(a) === normalize(b);
}

/**
 * Whether the running dashboard is safe to act through. Drift states trigger repair;
 * `disconnected` blocks mutating keys while the service reconnects.
 */
export type RuntimeGuardState =
  | { kind: "ok" }
  | { kind: "stale"; reason: "self-drift" | "service-mismatch" }
  | { kind: "runtime-rebuild-required" }
  | { kind: "disconnected" };

export interface RuntimeGuardInput {
  selfDrift: boolean;
  runtimeRebuildRequired?: boolean;
  endpointPresent: boolean;
  serviceManifest: ProjectServiceManifest | null | "unreachable";
  serviceIdentityMismatch?: boolean;
}

/**
 * Pure decision. Priority: a binary that changed on disk (self-drift) wins over everything —
 * it is the definitive "reload me" regardless of the service. Then disconnection, then a
 * version disagreement with the live service.
 */
export function evaluateRuntimeGuard(input: RuntimeGuardInput): RuntimeGuardState {
  if (input.selfDrift) return { kind: "stale", reason: "self-drift" };
  if (input.runtimeRebuildRequired) return { kind: "runtime-rebuild-required" };
  if (!input.endpointPresent || input.serviceManifest === "unreachable" || input.serviceManifest === null) {
    return { kind: "disconnected" };
  }
  if (input.serviceIdentityMismatch) return { kind: "stale", reason: "service-mismatch" };
  if (!manifestsMatch(getProjectServiceManifest(), input.serviceManifest)) {
    return { kind: "stale", reason: "service-mismatch" };
  }
  return { kind: "ok" };
}

export function runtimeGuardEquals(a: RuntimeGuardState, b: RuntimeGuardState): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "stale" ? a.reason === (b as { reason: string }).reason : true;
}

export function stabilizeRuntimeGuardProbe(
  current: RuntimeGuardState,
  next: RuntimeGuardState,
  disconnectedProbeCount: number,
  threshold = 2,
): { state: RuntimeGuardState; disconnectedProbeCount: number } {
  if (next.kind !== "disconnected") {
    return { state: next, disconnectedProbeCount: 0 };
  }
  const count = disconnectedProbeCount + 1;
  if (current.kind === "disconnected" || count >= threshold) {
    return { state: next, disconnectedProbeCount: count };
  }
  return { state: current, disconnectedProbeCount: count };
}

// Keys that are non-mutating on every screen. Quit is allowed so a disconnected
// guard cannot trap the user inside the dashboard.
const GUARD_PASSTHROUGH_KEYS = new Set(["up", "down", "j", "k", "tab", "?", "q"]);

/** What a keystroke should do while the dashboard is guarded. Repair is automatic. */
export function runtimeGuardKeyDisposition(key: string): "passthrough" | "swallow" {
  const command = key.length === 1 ? key.toLowerCase() : key;
  if (GUARD_PASSTHROUGH_KEYS.has(command)) return "passthrough";
  return "swallow";
}

/** Overlay title + body copy for a non-ok guard state. */
export function runtimeGuardOverlayCopy(state: RuntimeGuardState): { title: string; lines: string[] } {
  if (state.kind === "stale" && state.reason === "self-drift") {
    return {
      title: "Aimux is updating",
      lines: ["Aimux is applying the current build.", "Actions resume automatically when repair completes."],
    };
  }
  if (state.kind === "stale") {
    return {
      title: "Aimux is syncing",
      lines: ["Aimux is syncing the dashboard with the project service.", "Actions resume automatically."],
    };
  }
  if (state.kind === "disconnected") {
    return {
      title: "Aimux is reconnecting",
      lines: ["Aimux is reconnecting the project service.", "Actions resume automatically."],
    };
  }
  if (state.kind === "runtime-rebuild-required") {
    return {
      title: "Aimux is repairing tmux",
      lines: ["Aimux is repairing the managed tmux runtime.", "Actions resume automatically."],
    };
  }
  return { title: "", lines: [] };
}

function readRuntimeRebuildRequired(projectRoot: string): boolean {
  try {
    const tmux = new TmuxRuntimeManager();
    if (!tmux.isAvailable()) return false;
    const sessionName = tmux.getProjectSession(projectRoot).sessionName;
    const sessionNames = tmux.listSessionNames();
    if (!sessionNames.includes(sessionName)) {
      return false;
    }
    const rebuildMarker = tmux.getSessionOption(sessionName, TMUX_RUNTIME_REBUILD_REQUIRED_OPTION);
    if (rebuildMarker === "1") {
      return true;
    }
    const hostProjectRoot = tmux.getSessionOption(sessionName, "@aimux-project-root") || projectRoot;
    const hostContract = tmux.getSessionOption(sessionName, TMUX_RUNTIME_CONTRACT_OPTION);
    if (hostContract !== AIMUX_TMUX_RUNTIME_CONTRACT_VERSION) {
      return true;
    }
    return sessionNames
      .filter((name) => isTmuxClientSessionForHost(name, sessionName))
      .some((name) => {
        const clientHost = tmux.getSessionOption(name, "@aimux-host-session");
        if (clientHost !== sessionName) return false;
        const clientRoot = tmux.getSessionOption(name, "@aimux-project-root");
        if (!sameFilesystemPath(clientRoot, hostProjectRoot)) return false;
        const clientContract = tmux.getSessionOption(name, TMUX_RUNTIME_CONTRACT_OPTION);
        if (clientContract === AIMUX_TMUX_RUNTIME_CONTRACT_VERSION) return false;
        return true;
      });
  } catch {
    return false;
  }
}

/** Best-effort probe. Endpoint discovery and service transport failures resolve to a guard state. */
export async function probeRuntimeGuard(projectRoot: string = process.cwd()): Promise<RuntimeGuardState> {
  const selfDrift = hasProjectServiceBuildDrift();
  const runtimeRebuildRequired = readRuntimeRebuildRequired(projectRoot);
  let endpointPresent = false;
  let serviceManifest: ProjectServiceManifest | null | "unreachable" = null;
  let serviceIdentityMismatch = false;
  let endpoint: ReturnType<typeof loadMetadataEndpoint> | undefined;
  try {
    endpoint = loadMetadataEndpoint(projectRoot);
  } catch {
    endpointPresent = false;
    serviceManifest = null;
  }
  endpointPresent = Boolean(endpoint);
  if (endpoint) {
    let health:
      | {
          status: number;
          json?: {
            pid?: number;
            projectStateDir?: string;
            serviceInfo?: ProjectServiceManifest;
          };
        }
      | undefined;
    try {
      health = await requestJson<{
        pid?: number;
        projectStateDir?: string;
        serviceInfo?: ProjectServiceManifest;
      }>(`http://${endpoint.host}:${endpoint.port}/health`, { timeoutMs: HEALTH_TIMEOUT_MS });
    } catch {
      serviceManifest = "unreachable";
    }
    if (health) {
      const { status, json } = health;
      if (status >= 200 && status < 300) {
        if (json?.serviceInfo) serviceManifest = json.serviceInfo;
        else serviceManifest = getProjectServiceManifest();
        serviceIdentityMismatch =
          json?.pid !== endpoint.pid ||
          json?.projectStateDir !== getProjectStateDirFor(projectRoot) ||
          !json?.serviceInfo;
      } else {
        serviceManifest = "unreachable";
      }
    }
  }
  return evaluateRuntimeGuard({
    selfDrift,
    runtimeRebuildRequired,
    endpointPresent,
    serviceManifest,
    serviceIdentityMismatch,
  });
}
