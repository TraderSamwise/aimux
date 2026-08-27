import { describe, expect, it } from "vitest";
import { parseDashboardControlScreen } from "./dashboard-client-state.js";

describe("dashboard client state", () => {
  it("parses supported dashboard control screens", () => {
    expect(parseDashboardControlScreen("dashboard")).toBe("dashboard");
    expect(parseDashboardControlScreen(" coordination ")).toBe("coordination");
    expect(parseDashboardControlScreen("project")).toBe("project");
    expect(parseDashboardControlScreen("library")).toBe("library");
    expect(parseDashboardControlScreen("topology")).toBe("topology");
    expect(parseDashboardControlScreen("graveyard")).toBe("graveyard");
  });

  it("ignores unsupported dashboard control screens", () => {
    expect(parseDashboardControlScreen("agent")).toBeUndefined();
    expect(parseDashboardControlScreen(undefined)).toBeUndefined();
  });
});
