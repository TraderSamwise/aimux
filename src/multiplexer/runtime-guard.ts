import { requestJson } from "../http-client.js";
import { resolveProjectServiceEndpoint } from "../metadata-store.js";
import {
  getProjectServiceManifest,
  hasProjectServiceBuildDrift,
  manifestsMatch,
  type ProjectServiceManifest,
} from "../project-service-manifest.js";

// A dead/wedged service must not stall the dashboard loop, so the health probe is bounded.
const HEALTH_TIMEOUT_MS = 2500;

/**
 * Whether the running dashboard is safe to act through. `stale` means this process is out of
 * date (its own binary changed on disk, or it disagrees with the live service) and should
 * reload before mutating anything; `disconnected` means the authority is unreachable.
 */
export type RuntimeGuardState =
  | { kind: "ok" }
  | { kind: "stale"; reason: "self-drift" | "service-mismatch" }
  | { kind: "disconnected" };

export interface RuntimeGuardInput {
  selfDrift: boolean;
  endpointPresent: boolean;
  serviceManifest: ProjectServiceManifest | null | "unreachable";
}

/**
 * Pure decision. Priority: a binary that changed on disk (self-drift) wins over everything —
 * it is the definitive "reload me" regardless of the service. Then disconnection, then a
 * version disagreement with the live service.
 */
export function evaluateRuntimeGuard(input: RuntimeGuardInput): RuntimeGuardState {
  if (input.selfDrift) return { kind: "stale", reason: "self-drift" };
  if (!input.endpointPresent || input.serviceManifest === "unreachable" || input.serviceManifest === null) {
    return { kind: "disconnected" };
  }
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

// Keys that are non-mutating on EVERY screen (selection/scroll/quit/help). Screen-switch
// letters (d/c/p/l/t/g) are excluded because they mutate on their target subscreen (e.g. "c"
// is clear-all on Coordination), so under the guard you reload rather than browse.
const GUARD_PASSTHROUGH_KEYS = new Set(["up", "down", "j", "k", "tab", "escape", "q", "?"]);

/** What a keystroke should do while the dashboard is guarded (stale/disconnected). */
export function runtimeGuardKeyDisposition(key: string): "reload" | "passthrough" | "swallow" {
  const command = key.length === 1 ? key.toLowerCase() : key;
  if (command === "r") return "reload";
  if (GUARD_PASSTHROUGH_KEYS.has(command)) return "passthrough";
  return "swallow";
}

/** Overlay title + body copy for a non-ok guard state. */
export function runtimeGuardOverlayCopy(state: RuntimeGuardState): { title: string; lines: string[] } {
  if (state.kind === "stale" && state.reason === "self-drift") {
    return {
      title: "aimux updated — reload required",
      lines: [
        "This dashboard is running an old binary (the install changed on disk).",
        "Reload to pick up the new version before making any changes.",
      ],
    };
  }
  if (state.kind === "stale") {
    return {
      title: "Dashboard out of sync",
      lines: [
        "This dashboard disagrees with the project service version.",
        "Reload to resync before making any changes.",
      ],
    };
  }
  if (state.kind === "disconnected") {
    return {
      title: "Project service unreachable",
      lines: ["The dashboard can't reach the project service.", "Actions are paused until it reconnects."],
    };
  }
  return { title: "", lines: [] };
}

/** Best-effort probe. Never throws; any failure gathering inputs resolves to a safe state. */
export async function probeRuntimeGuard(projectRoot: string = process.cwd()): Promise<RuntimeGuardState> {
  const selfDrift = hasProjectServiceBuildDrift();
  let endpointPresent = false;
  let serviceManifest: ProjectServiceManifest | null | "unreachable" = null;
  try {
    const endpoint = resolveProjectServiceEndpoint(projectRoot);
    endpointPresent = Boolean(endpoint);
    if (endpoint) {
      try {
        const { status, json } = await requestJson<{ serviceInfo?: ProjectServiceManifest }>(
          `http://${endpoint.host}:${endpoint.port}/health`,
          { timeoutMs: HEALTH_TIMEOUT_MS },
        );
        serviceManifest = status >= 200 && status < 300 && json?.serviceInfo ? json.serviceInfo : "unreachable";
      } catch {
        serviceManifest = "unreachable";
      }
    }
  } catch {
    endpointPresent = false;
    serviceManifest = null;
  }
  return evaluateRuntimeGuard({ selfDrift, endpointPresent, serviceManifest });
}
