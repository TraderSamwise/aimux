import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ View: "View" }));
vi.mock("jotai", () => ({ useSetAtom: vi.fn(() => vi.fn()) }));
vi.mock("lucide-react-native", () => ({
  GitFork: "GitFork",
  Play: "Play",
  Radar: "Radar",
  ShieldOff: "ShieldOff",
  Square: "Square",
  Trash2: "Trash2",
}));
vi.mock("@/components/ui/button", () => ({ Button: "Button" }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));
vi.mock("@/lib/api", () => ({
  forkAgent: vi.fn(),
  killAgent: vi.fn(),
  resumeAgent: vi.fn(),
  setAgentOverseer: vi.fn(),
  stopAgent: vi.fn(),
}));
vi.mock("@/stores/desktopState", () => ({ kickDesktopStateRefreshAtom: {} }));
vi.mock("@/stores/lifecycleTransitions", () => ({
  failLocalProjectLifecycleTransition: vi.fn(),
  localProjectLifecycleTransition: vi.fn(),
  recordProjectLifecycleTransitionAtom: {},
}));
vi.mock("@/stores/projectViews", () => ({ kickProjectApiViewRefreshAtom: {} }));

import type { DesktopSession } from "@/lib/desktop-state";
import { overseerActionForSession } from "@/components/agent-actions";

function session(input: Partial<DesktopSession> = {}): DesktopSession {
  return { id: "agent-1", status: "running", ...input };
}

describe("overseer row actions", () => {
  it("promotes ordinary agents and demotes explicit overseers", () => {
    expect(overseerActionForSession(session())).toBe("promote");
    expect(overseerActionForSession(session({ overseer: true, projectControl: true }))).toBe(
      "demote",
    );
  });

  it("does not infer supervisor controls from absent relay role fields", () => {
    expect(overseerActionForSession(session({ role: "overseer" }))).toBe("promote");
    expect(overseerActionForSession(session({ team: { role: "overseer" } }))).toBe("promote");
    expect(overseerActionForSession(session({ projectControl: true, role: "qa" }))).toBeNull();
    expect(overseerActionForSession(session({ scribe: true, projectControl: true }))).toBeNull();
  });
});
