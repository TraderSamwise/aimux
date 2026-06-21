import { describe, expect, it, vi } from "vitest";

import { getProjectServiceManifest } from "../project-service-manifest.js";
import { buildDashboardRuntimeGuardOverlayOutput } from "../tui/screens/overlay-renderers.js";
import { handleRuntimeGuardKey } from "./dashboard-control.js";
import {
  evaluateRuntimeGuard,
  runtimeGuardEquals,
  runtimeGuardKeyDisposition,
  runtimeGuardOverlayCopy,
  stabilizeRuntimeGuardProbe,
  type RuntimeGuardState,
} from "./runtime-guard.js";

const liveManifest = getProjectServiceManifest();

describe("evaluateRuntimeGuard", () => {
  it("flags self-drift above everything, even when the service matches", () => {
    expect(evaluateRuntimeGuard({ selfDrift: true, endpointPresent: true, serviceManifest: liveManifest })).toEqual({
      kind: "stale",
      reason: "self-drift",
    });
  });

  it("reports disconnected when there is no endpoint", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: false, serviceManifest: null })).toEqual({
      kind: "disconnected",
    });
  });

  it("reports disconnected when the service is unreachable", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: "unreachable" })).toEqual({
      kind: "disconnected",
    });
  });

  it("reports disconnected when an endpoint is present but no manifest came back", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: null })).toEqual({
      kind: "disconnected",
    });
  });

  it("reports ok when the live service manifest matches ours", () => {
    expect(evaluateRuntimeGuard({ selfDrift: false, endpointPresent: true, serviceManifest: liveManifest })).toEqual({
      kind: "ok",
    });
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

describe("runtimeGuardEquals", () => {
  it("matches identical states and distinguishes stale reasons", () => {
    expect(runtimeGuardEquals({ kind: "ok" }, { kind: "ok" })).toBe(true);
    expect(runtimeGuardEquals({ kind: "disconnected" }, { kind: "disconnected" })).toBe(true);
    expect(runtimeGuardEquals({ kind: "ok" }, { kind: "disconnected" })).toBe(false);
    expect(runtimeGuardEquals({ kind: "stale", reason: "self-drift" }, { kind: "stale", reason: "self-drift" })).toBe(
      true,
    );
    expect(
      runtimeGuardEquals({ kind: "stale", reason: "self-drift" }, { kind: "stale", reason: "service-mismatch" }),
    ).toBe(false);
  });
});

describe("stabilizeRuntimeGuardProbe", () => {
  it("keeps an ok dashboard unguarded for one missed disconnected probe", () => {
    expect(stabilizeRuntimeGuardProbe({ kind: "ok" }, { kind: "disconnected" }, 0)).toEqual({
      state: { kind: "ok" },
      disconnectedProbeCount: 1,
    });
  });

  it("reports disconnected after repeated misses", () => {
    expect(stabilizeRuntimeGuardProbe({ kind: "ok" }, { kind: "disconnected" }, 1)).toEqual({
      state: { kind: "disconnected" },
      disconnectedProbeCount: 2,
    });
  });

  it("resets the missed-probe count on ok or stale probes", () => {
    expect(stabilizeRuntimeGuardProbe({ kind: "ok" }, { kind: "ok" }, 1)).toEqual({
      state: { kind: "ok" },
      disconnectedProbeCount: 0,
    });
    expect(stabilizeRuntimeGuardProbe({ kind: "ok" }, { kind: "stale", reason: "service-mismatch" }, 1)).toEqual({
      state: { kind: "stale", reason: "service-mismatch" },
      disconnectedProbeCount: 0,
    });
  });
});

describe("runtimeGuardKeyDisposition", () => {
  it("reloads on R, passes safe nav keys, swallows everything else", () => {
    expect(runtimeGuardKeyDisposition("R")).toBe("reload");
    expect(runtimeGuardKeyDisposition("r")).toBe("reload");
    for (const key of ["up", "down", "j", "k", "tab", "escape", "q", "?"]) {
      expect(runtimeGuardKeyDisposition(key)).toBe("passthrough");
    }
    // Screen-switch letters mutate on their subscreens (e.g. "c" = clear-all) → swallowed.
    for (const key of ["c", "d", "p", "l", "t", "g", "n", "x", "f", "enter", "1"]) {
      expect(runtimeGuardKeyDisposition(key)).toBe("swallow");
    }
  });
});

describe("runtimeGuardOverlayCopy", () => {
  it("gives each non-ok state a distinct, non-empty title", () => {
    const titles = (["self-drift", "service-mismatch"] as const).map(
      (reason) => runtimeGuardOverlayCopy({ kind: "stale", reason }).title,
    );
    titles.push(runtimeGuardOverlayCopy({ kind: "disconnected" }).title);
    expect(new Set(titles).size).toBe(3);
    expect(titles.every((t) => t.length > 0)).toBe(true);
    expect(runtimeGuardOverlayCopy({ kind: "ok" }).title).toBe("");
  });
});

describe("buildDashboardRuntimeGuardOverlayOutput", () => {
  it("renders nothing when ok and an overlay carrying the title otherwise", () => {
    expect(buildDashboardRuntimeGuardOverlayOutput({ runtimeGuardState: { kind: "ok" } }, 120, 40)).toBeNull();
    const out = buildDashboardRuntimeGuardOverlayOutput({ runtimeGuardState: { kind: "disconnected" } }, 120, 40);
    expect(out?.toLowerCase()).toContain("unreachable");
  });
});

describe("handleRuntimeGuardKey", () => {
  function stubHost(state: RuntimeGuardState) {
    return {
      runtimeGuardState: state,
      footerFlash: "",
      footerFlashTicks: 0,
      renderCurrentDashboardView: vi.fn(),
      reloadDashboardFromGuard: vi.fn(),
    };
  }

  it("does not intercept when the guard is ok", () => {
    const host = stubHost({ kind: "ok" });
    expect(handleRuntimeGuardKey(host, Buffer.from("n"))).toBe(false);
  });

  it("swallows a mutating key and flashes when guarded", () => {
    const host = stubHost({ kind: "stale", reason: "self-drift" });
    expect(handleRuntimeGuardKey(host, Buffer.from("n"))).toBe(true);
    expect(host.footerFlash).toContain("press R to reload");
    expect(host.reloadDashboardFromGuard).not.toHaveBeenCalled();
  });

  it("lets a safe nav key through when guarded", () => {
    const host = stubHost({ kind: "disconnected" });
    expect(handleRuntimeGuardKey(host, Buffer.from("k"))).toBe(false);
  });

  it("triggers reload on R when guarded", () => {
    const host = stubHost({ kind: "stale", reason: "service-mismatch" });
    expect(handleRuntimeGuardKey(host, Buffer.from("R"))).toBe(true);
    expect(host.reloadDashboardFromGuard).toHaveBeenCalledTimes(1);
  });
});
