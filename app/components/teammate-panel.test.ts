import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
}));

vi.mock("lucide-react-native", () => ({
  Play: "Play",
  RefreshCw: "RefreshCw",
  Send: "Send",
  Square: "Square",
  Trash2: "Trash2",
  Users: "Users",
}));

import { displayTeammateName, TeammateListStateMessage } from "@/components/teammate-panel";

type FunctionComponentNode = (props: unknown) => ReactNode;

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (!React.isValidElement(node)) return "";

  if (node.type === React.Fragment) {
    return collectText((node.props as { children?: ReactNode }).children);
  }

  if (typeof node.type === "function") {
    return collectText((node.type as FunctionComponentNode)(node.props));
  }

  return collectText((node.props as { children?: ReactNode }).children);
}

describe("displayTeammateName", () => {
  it("does not fall back to a role string for GUI labels", () => {
    expect(displayTeammateName({ id: "tm-1", label: "", role: "scribe" })).toBe("tm-1");
  });

  it("keeps explicit teammate labels visible", () => {
    expect(displayTeammateName({ id: "tm-1", label: "review partner", role: "scribe" })).toBe(
      "review partner",
    );
  });
});

describe("TeammateListStateMessage", () => {
  it("renders liveness query failure separately from an empty teammate list", () => {
    const text = collectText(
      React.createElement(TeammateListStateMessage, {
        error:
          "could not verify agent tmux liveness: tmux socket busy: tmux window query failed: tmux list-windows timed out",
      }),
    );

    expect(text).toContain("Runtime inventory unavailable");
    expect(text).toContain("teammate liveness could not be verified");
    expect(text).not.toContain("No teammates");
  });

  it("renders the genuine empty teammate state when inventory was verified", () => {
    const text = collectText(React.createElement(TeammateListStateMessage, { error: null }));

    expect(text).toBe("No teammates");
  });
});
