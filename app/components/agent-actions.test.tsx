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
  setAgentPlane: vi.fn(),
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
import { overseerActionForSession, planeActionForSession } from "@/components/agent-actions";

function session(input: Partial<DesktopSession> = {}): DesktopSession {
  return { id: "agent-1", status: "running", ...input };
}

describe("plane row action", () => {
  it("offers to move an ordinary agent into the supervisor plane", () => {
    expect(planeActionForSession(session())).toEqual({ kind: "join" });
  });

  // Clearing the stored plane only falls back to the derived one, and for an
  // agent in the plane by role that is the same plane -- so leaving has to name
  // the worktree to move to.
  it("names the worktree to leave to rather than clearing the plane", () => {
    expect(
      planeActionForSession(
        session({ lane: { kind: "supervisor" }, worktreePath: "/repo/feature" }),
        "/repo",
      ),
    ).toEqual({ kind: "leave", worktreePath: "/repo/feature" });

    expect(planeActionForSession(session({ lane: { kind: "supervisor" } }), "/repo")).toEqual({
      kind: "leave",
      worktreePath: "/repo",
    });
  });

  // The payload carries the effective plane, so an agent held there by its role
  // is indistinguishable from one put there. With nowhere to move it to, saying
  // so beats a button that appears to work and does nothing.
  it("says an agent is held by its role when there is no worktree to leave to", () => {
    expect(planeActionForSession(session({ lane: { kind: "supervisor" } }))).toEqual({
      kind: "held-by-role",
    });
  });

  it("reads the plane, not the role", () => {
    expect(planeActionForSession(session({ overseer: true, projectControl: true }))).toEqual({
      kind: "join",
    });
  });
});

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
