import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  isQueuedLifecycleRoute,
  PROJECT_API_QUEUED_LIFECYCLE_TIMEOUTS,
  PROJECT_API_ROUTES,
  queuedLifecycleTimeoutMs,
  QUEUED_LIFECYCLE_MAX_TIMEOUT_MS,
} from "../../src/project-api-contract";

// The Rust half is `lifecycle_queue_routes_across_surfaces.rs`, which asserts
// this same fixture against `lifecycle_transition_for_route` -- the function
// that actually takes the permit. Neither side can move alone. The fixture also
// carries the budget, so the number is not written out twice.
//
// This lives here rather than beside the contract because `src/` is a retired
// tree and `scripts/check-local-build-boundary.mjs` refuses new files in it.
const FIXTURE = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "testdata",
      "contracts",
      "v1",
      "lifecycle-queue",
      "queued-routes.json",
    ),
    "utf8",
  ),
) as { defaultTimeoutMs: number; routes: Record<string, number> };

/// Read as text because the wiring is what matters, not a value: the decision
/// has to happen at the choke point that still holds the bare route.
function apiSource(): string {
  return readFileSync(join(__dirname, "api.ts"), "utf8");
}

describe("queued lifecycle routes", () => {
  it("publishes exactly the routes that take the permit, with their budgets", () => {
    // Per route, not one flat number: five of them do real filesystem work
    // once they hold the permit, and the dashboard raised each of those only
    // after it was caught calling a working operation a transport timeout.
    expect(PROJECT_API_QUEUED_LIFECYCLE_TIMEOUTS).toEqual(FIXTURE.routes);
  });

  it("gives the slow routes more than the default, not the same", () => {
    const slow = queuedLifecycleTimeoutMs(PROJECT_API_ROUTES.worktreeActions.create);
    const normal = queuedLifecycleTimeoutMs(PROJECT_API_ROUTES.agents.spawn);
    expect(normal).toBe(FIXTURE.defaultTimeoutMs);
    expect(slow).toBeGreaterThan(FIXTURE.defaultTimeoutMs);
    expect(QUEUED_LIFECYCLE_MAX_TIMEOUT_MS).toBe(slow);
  });

  it("recognises a route however the request names it", () => {
    const spawn = PROJECT_API_ROUTES.agents.spawn;
    expect(isQueuedLifecycleRoute(spawn)).toBe(true);
    expect(isQueuedLifecycleRoute(`http://127.0.0.1:43210${spawn}`)).toBe(true);
    expect(isQueuedLifecycleRoute(`/proxy/host/43210${spawn}`)).toBe(true);
    expect(isQueuedLifecycleRoute(`http://relay.example/proxy/h/1${spawn}`)).toBe(true);
    expect(isQueuedLifecycleRoute(`${spawn}?dryRun=1`)).toBe(true);
  });

  it("claims no route it was not given", () => {
    expect(isQueuedLifecycleRoute("/agents")).toBe(false);
    // In the lifecycle route GROUP but takes no permit, and a user-cancel is
    // the last thing that should wait two minutes.
    expect(isQueuedLifecycleRoute(PROJECT_API_ROUTES.agents.interrupt)).toBe(false);
    expect(isQueuedLifecycleRoute(PROJECT_API_ROUTES.agents.recordBackendSession)).toBe(false);
    expect(isQueuedLifecycleRoute("/elsewhere/agents/spawn")).toBe(false);
    expect(isQueuedLifecycleRoute("")).toBe(false);
  });
});

describe("the app waits as long as the lifecycle queue will make it wait", () => {
  it("decides at the one place that still holds the bare route", () => {
    // `callServiceViaRelay` rewrites the path to `/proxy/<host>/<port><path>`,
    // so a decision made after that point would never match a route list.
    const source = apiSource();
    const chokePoint = source.slice(
      source.indexOf("async function callProjectJson"),
      source.indexOf("function projectProxyPath"),
    );
    expect(chokePoint).toContain("withQueuedLifecycleTimeout(path, opts)");
    expect(chokePoint).not.toContain("callServiceViaRelay<T>(endpoint, method, path, opts, body)");
  });

  it("gives a queued route the queue's budget and leaves a read alone", () => {
    expect(isQueuedLifecycleRoute(PROJECT_API_ROUTES.agents.spawn)).toBe(true);
    expect(isQueuedLifecycleRoute(PROJECT_API_ROUTES.agents.list)).toBe(false);
    expect(queuedLifecycleTimeoutMs(PROJECT_API_ROUTES.agents.spawn)).toBeGreaterThan(10_000);
  });

  it("does not override a caller that asked for its own budget", () => {
    const source = apiSource();
    expect(source).toContain("if (opts?.timeoutMs !== undefined) return opts;");
  });

  it("says the work may still be running, because a retry is a second agent", () => {
    const source = apiSource();
    const message = source.slice(
      source.indexOf("function timedOutMessage"),
      source.indexOf("function abortedRequest"),
    );
    expect(message).toContain("may still be running, check first");
    expect(message).toContain("isQueuedLifecycleRoute(target)");
    // Both timeout paths report through it: the direct fetch's abort reason and
    // the relay's race.
    expect((source.match(/timedOutMessage\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the transports in between", () => {
  it("does not cap the relay below the longest budget", () => {
    // A 30s cap rejected a worktree create before the caller's own timer ran,
    // so the message lost the sentence saying the work may still be running.
    const relay = readFileSync(join(__dirname, "relay-transport.ts"), "utf8");
    expect(relay).toContain("QUEUED_LIFECYCLE_MAX_TIMEOUT_MS");
    expect(relay).not.toMatch(/const REQUEST_TIMEOUT_MS = 30_000;/);
  });

  it("treats a non-finite budget as the longest, not as zero", () => {
    // `setTimeout` coerces Infinity and fires at once, so "no timeout" would
    // have aborted immediately.
    expect(apiSource()).toContain("Number.isFinite(requested)");
  });
});

describe("the shared predicate", () => {
  it("is not fooled by a path that merely ends with a queued route", () => {
    expect(isQueuedLifecycleRoute("/elsewhere/agents/spawn")).toBe(false);
  });

  it("is used rather than a second copy of the list", () => {
    expect(apiSource()).not.toContain('"/agents/spawn"');
    expect(vi.isMockFunction(isQueuedLifecycleRoute)).toBe(false);
  });
});
