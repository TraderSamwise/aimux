import { describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({
  useGlobalSearchParams: () => ({}),
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@react-navigation/native", () => ({
  TabActions: {
    jumpTo: (name: string, params?: Record<string, string>) => ({
      type: "JUMP_TO",
      payload: { name, params },
    }),
  },
}));

import { buildMainTabHref, MAIN_TAB_ROUTES } from "./main-tabs";

describe("main tab navigation", () => {
  it("uses internal grouped routes for imperative tab switches", () => {
    expect(buildMainTabHref("threads", "/Users/sam/cs/aimux")).toEqual({
      pathname: "/(main)/(tabs)/threads",
      params: { project: "/Users/sam/cs/aimux" },
    });
    expect(buildMainTabHref("inbox", "/Users/sam/cs/aimux")).toEqual({
      pathname: "/(main)/(tabs)/notifications",
      params: { project: "/Users/sam/cs/aimux" },
    });
  });

  it("keeps public routes separate from internal tab targets", () => {
    expect(MAIN_TAB_ROUTES.threads.href).toBe("/threads");
    expect(MAIN_TAB_ROUTES.threads.internalHref).toBe("/(main)/(tabs)/threads");
  });

  it("omits empty project params", () => {
    expect(buildMainTabHref("project", "")).toEqual({
      pathname: "/(main)/(tabs)/project",
      params: {},
    });
  });
});
