import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiplexerRuntimeSync } from "./runtime-sync.js";

function createRuntimeSync(mode: "dashboard" | "project-service") {
  const deps = {
    cwd: "/repo",
    getMode: vi.fn(() => mode),
    syncSessionsFromTopology: vi.fn(),
    loadOfflineTopologySessions: vi.fn(() => false),
    renderCurrentDashboardView: vi.fn(),
    renderDashboard: vi.fn(),
    writeStatuslineFile: vi.fn(),
    refreshRuntimeGuard: vi.fn(),
  };
  return { deps, sync: new MultiplexerRuntimeSync(deps) };
}

describe("MultiplexerRuntimeSync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run tmux topology sync from the heartbeat in project-service mode", () => {
    vi.useFakeTimers();
    const { deps, sync } = createRuntimeSync("project-service");

    sync.startHeartbeat();
    vi.advanceTimersByTime(15_000);
    sync.stopHeartbeat();

    expect(deps.syncSessionsFromTopology).not.toHaveBeenCalled();
  });

  it("does not run tmux topology repair from a project-service timer", () => {
    vi.useFakeTimers();
    const { deps, sync } = createRuntimeSync("project-service");

    sync.startProjectServiceRefresh();
    vi.advanceTimersByTime(5 * 60_000);
    sync.stopProjectServiceRefresh();

    expect(deps.syncSessionsFromTopology).not.toHaveBeenCalled();
  });
});
