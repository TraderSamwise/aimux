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
