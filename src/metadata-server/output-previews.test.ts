import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeExposePreviewSnapshots,
  ProjectOutputPreviewCoordinator,
  type MetadataReadAgentOutput,
} from "./output-previews.js";

describe("mergeExposePreviewSnapshots", () => {
  it("keeps capture output when it already includes tap output", () => {
    expect(
      mergeExposePreviewSnapshots(
        { output: "one\ntwo\n", capturedAt: "2026-01-01T00:00:00.000Z", source: "capture", windowId: "@1" },
        { output: "two\n", capturedAt: "2026-01-01T00:00:01.000Z", source: "tap", windowId: "@1" },
      ),
    ).toEqual({ output: "one\ntwo\n", capturedAt: "2026-01-01T00:00:00.000Z", source: "capture", windowId: "@1" });
  });

  it("extends capture output when tap output appends new text", () => {
    expect(
      mergeExposePreviewSnapshots(
        { output: "one", capturedAt: "2026-01-01T00:00:00.000Z", source: "capture", windowId: "@1" },
        { output: "two", capturedAt: "2026-01-01T00:00:01.000Z", source: "tap", windowId: "@1" },
      ),
    ).toEqual({ output: "one\ntwo", capturedAt: "2026-01-01T00:00:01.000Z", source: "tap", windowId: "@1" });
  });
});

describe("ProjectOutputPreviewCoordinator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces repeated output reads for the same session and line", async () => {
    let calls = 0;
    const readAgentOutput: MetadataReadAgentOutput = async (input) => {
      calls += 1;
      return {
        sessionId: input.sessionId,
        output: "hello",
        startLine: input.startLine,
      };
    };
    const coordinator = new ProjectOutputPreviewCoordinator({
      currentProjectRoot: () => process.cwd(),
      isServerRunning: () => true,
      readAgentOutput,
      exposePreviewCache: false,
      exposePaneOutputTap: false,
      exposeHotSnapshots: false,
      runInProjectContext: (fn) => fn(),
    });

    const first = await coordinator.measureAgentOutputRead("events", { sessionId: "agent-1", startLine: -20 });
    const second = await coordinator.measureAgentOutputRead("events", { sessionId: "agent-1", startLine: -20 });

    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not touch visual client leases when no preview was requested", () => {
    const coordinator = new ProjectOutputPreviewCoordinator({
      currentProjectRoot: () => process.cwd(),
      isServerRunning: () => true,
      exposePreviewCache: false,
      exposePaneOutputTap: false,
      exposeHotSnapshots: false,
      runInProjectContext: (fn) => fn(),
    });
    const req = { socket: { remoteAddress: "127.0.0.1" } } as any;
    const url = new URL("http://localhost/agents");

    expect(
      coordinator.touchVisualClientLease(req, url, {
        surface: "expose",
        requestedPreview: false,
        requestedChatPreview: false,
      }),
    ).toBe(false);
    expect(coordinator.diagnostics()).toMatchObject({ clients: { active: [], activePreviewClients: 0 } });
  });

  it("keeps default preview readers disabled when no output reader is available", () => {
    const coordinator = new ProjectOutputPreviewCoordinator({
      currentProjectRoot: () => process.cwd(),
      isServerRunning: () => true,
      runInProjectContext: (fn) => fn(),
    });

    expect(coordinator.diagnostics()).toMatchObject({ cache: null, taps: null });
  });
});
