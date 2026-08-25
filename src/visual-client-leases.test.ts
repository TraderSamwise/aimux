import { describe, expect, it } from "vitest";
import { VisualClientLeaseRegistry, parseVisualClientKind } from "./visual-client-leases.js";

describe("parseVisualClientKind", () => {
  it("accepts known visual client kinds", () => {
    expect(parseVisualClientKind("tui")).toBe("tui");
    expect(parseVisualClientKind("web")).toBe("web");
    expect(parseVisualClientKind("mobile")).toBe("mobile");
    expect(parseVisualClientKind("expose")).toBe("expose");
  });

  it("defaults unknown kinds to api", () => {
    expect(parseVisualClientKind("dashboard")).toBe("api");
    expect(parseVisualClientKind(null)).toBe("api");
  });
});

describe("VisualClientLeaseRegistry", () => {
  it("tracks active visual clients by kind", () => {
    let nowMs = Date.parse("2026-08-25T00:00:00.000Z");
    const registry = new VisualClientLeaseRegistry({ now: () => new Date(nowMs) });

    registry.touch({
      id: "dashboard:1",
      kind: "tui",
      surface: "desktop-state",
      requestedPreview: true,
      ttlMs: 5000,
    });
    registry.touch({
      id: "app-expose",
      kind: "web",
      surface: "expose",
      requestedPreview: true,
      requestedChatPreview: true,
    });

    expect(registry.snapshot()).toMatchObject({
      counts: { tui: 1, web: 1, mobile: 0, expose: 0, api: 0 },
      activePreviewClients: 2,
    });
    expect(registry.hasActivePreviewClients()).toBe(true);

    nowMs += 6000;
    expect(registry.snapshot()).toMatchObject({
      counts: { tui: 0, web: 1, mobile: 0, expose: 0, api: 0 },
      activePreviewClients: 1,
    });
  });

  it("renews a matching lease without changing startedAt", () => {
    let nowMs = Date.parse("2026-08-25T00:00:00.000Z");
    const registry = new VisualClientLeaseRegistry({ now: () => new Date(nowMs) });
    const first = registry.touch({
      id: "client",
      kind: "expose",
      surface: "expose",
      requestedPreview: true,
      ttlMs: 1000,
    });

    nowMs += 500;
    const second = registry.touch({
      id: "client",
      kind: "expose",
      surface: "expose",
      requestedPreview: true,
      ttlMs: 2000,
    });

    expect(second.startedAt).toBe(first.startedAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(registry.snapshot().counts.expose).toBe(1);
  });
});
