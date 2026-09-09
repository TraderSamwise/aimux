import { Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IOS_MIN_TOP_INSET, resolveChromeTopInset } from "@/lib/native-safe-area";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

function setPlatformOS(os: typeof Platform.OS) {
  (Platform as { OS: typeof Platform.OS }).OS = os;
}

beforeEach(() => {
  setPlatformOS("ios");
});

describe("resolveChromeTopInset", () => {
  it("keeps the iOS top inset floor when reserving safe area", () => {
    setPlatformOS("ios");

    expect(resolveChromeTopInset(0)).toBe(IOS_MIN_TOP_INSET);
  });

  it("removes the top inset when wide chrome opts out of top safe area", () => {
    setPlatformOS("ios");

    expect(resolveChromeTopInset(54, { reserveTopSafeArea: false })).toBe(0);
  });
});
