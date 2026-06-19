import { describe, expect, it } from "vitest";

import { getProjectServiceManifest } from "../project-service-manifest.js";
import { evaluateRuntimeGuard } from "./runtime-guard.js";

const liveManifest = getProjectServiceManifest();

describe("evaluateRuntimeGuard", () => {
  it("flags self-drift above everything, even when the service matches", () => {
    expect(
      evaluateRuntimeGuard({ selfDrift: true, endpointPresent: true, serviceManifest: liveManifest }),
    ).toEqual({ kind: "stale", reason: "self-drift" });
  });

  it("reports disconnected when there is no endpoint", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: false, serviceManifest: null })).toEqual({
      kind: "disconnected",
    });
  });

  it("reports disconnected when the service is unreachable", () => {
    expect(
      evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: "unreachable" }),
    ).toEqual({ kind: "disconnected" });
  });

  it("reports disconnected when an endpoint is present but no manifest came back", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: null })).toEqual({
      kind: "disconnected",
    });
  });

  it("reports ok when the live service manifest matches ours", () => {
    expect(
      evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: liveManifest }),
    ).toEqual({ kind: "ok" });
  });

  it("flags a service-mismatch when build stamps differ", () => {
    expect(
      evaluateRuntimeGuard({
        selfDrift: false,
        endpointPresent: true,
        serviceManifest: { ...liveManifest, buildStamp: `${liveManifest.buildStamp}-other` },
      }),
    ).toEqual({ kind: "stale", reason: "service-mismatch" });
  });
});
