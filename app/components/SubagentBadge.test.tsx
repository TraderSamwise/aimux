import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert, Platform } from "react-native";
import { SubagentBadge } from "@/components/SubagentBadge";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Platform: { OS: "ios" },
  Alert: { alert: vi.fn() },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Platform.OS = "ios";
});
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));

const summary = {
  running: 2,
  label: "2 sub-agents",
  detail: "2 sub-agents: review parser (Explore), check routes (Plan)",
};

describe("sub-agent details", () => {
  it("renders the published label and exposes the full detail on tap", () => {
    const element = SubagentBadge({ subagents: summary })!;
    expect(element.props.accessibilityLabel).toBe(summary.detail);
    expect(React.Children.only(element.props.children).props.children).toBe(summary.label);
    const stopPropagation = vi.fn();
    element.props.onPress({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(Alert.alert).toHaveBeenCalledWith("Sub-agents", summary.detail);
  });

  it("uses a working web dialog instead of the native-web Alert stub", () => {
    Platform.OS = "web";
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    const element = SubagentBadge({ subagents: summary })!;
    element.props.onPress({ stopPropagation: vi.fn() });
    expect(alert).toHaveBeenCalledWith(summary.detail);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("renders nothing when no sub-agent is working", () => {
    expect(SubagentBadge({})).toBeNull();
    expect(SubagentBadge({ subagents: { ...summary, running: 0 } })).toBeNull();
  });
});
