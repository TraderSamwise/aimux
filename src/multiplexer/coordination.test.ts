import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { scheduleCoordinationPush } from "./coordination.js";

describe("scheduleCoordinationPush", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-coordination-push-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("does nothing when the coordination screen is not showing", () => {
    const host: any = {
      isDashboardScreen: vi.fn(() => false),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCoordination: vi.fn(),
    };

    scheduleCoordinationPush(host);

    expect(host.isDashboardScreen).toHaveBeenCalledWith("coordination");
    expect(host.refreshCoordinationFromService).not.toHaveBeenCalled();
    expect(host.renderCoordination).not.toHaveBeenCalled();
  });

  it("refreshes from the service when the screen is showing, then clears the coalescing flag", async () => {
    // Render goes through the module renderCoordination (not host.renderCoordination); we assert
    // the observable contract: the service refresh runs once and the coalescing flag resets.
    const host: any = {
      isDashboardScreen: vi.fn(() => true),
      coordinationLoaded: true,
      coordinationFilter: "all",
      coordinationWorklist: [],
      refreshCoordinationFromService: vi.fn(async () => true),
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      centerInWidth: (text: string) => text,
      truncatePlain: (text: string) => text,
      wrapKeyValue: (_key: string, value: string) => [value],
      writeFrame: vi.fn(),
    };

    scheduleCoordinationPush(host);
    await vi.waitFor(() => expect(host.coordinationPushScheduled).toBe(false));

    expect(host.refreshCoordinationFromService).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of events into a single refresh", async () => {
    let resolveRefresh: (() => void) | null = null;
    const host: any = {
      isDashboardScreen: vi.fn(() => true),
      coordinationLoaded: true,
      coordinationFilter: "all",
      coordinationWorklist: [],
      refreshCoordinationFromService: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRefresh = () => resolve(true);
          }),
      ),
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      centerInWidth: (text: string) => text,
      truncatePlain: (text: string) => text,
      wrapKeyValue: (_key: string, value: string) => [value],
      writeFrame: vi.fn(),
    };

    scheduleCoordinationPush(host);
    scheduleCoordinationPush(host); // coalesced: in-flight refresh blocks the second
    expect(host.refreshCoordinationFromService).toHaveBeenCalledTimes(1);

    resolveRefresh!();
    await vi.waitFor(() => expect(host.coordinationPushScheduled).toBe(false));
    expect(host.refreshCoordinationFromService).toHaveBeenCalledTimes(1);
  });
});
