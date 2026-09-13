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

import { displayTeammateName } from "@/components/teammate-panel";

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
