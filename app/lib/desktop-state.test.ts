import { describe, expect, it } from "vitest";
import type { DesktopSession, DesktopState } from "@/lib/desktop-state";
import { groupByWorktree } from "@/lib/desktop-state";

function session(input: Partial<DesktopSession> & Pick<DesktopSession, "id">): DesktopSession {
  return {
    status: "running",
    command: "codex",
    ...input,
  };
}

describe("desktop state model", () => {
  it("orders supervisor lane sessions by declared role order without reordering worktree agents", () => {
    const state: DesktopState = {
      ok: true,
      mainCheckoutInfo: { name: "aimux", branch: "master" },
      mainCheckoutPath: "/repo",
      worktrees: [{ name: "feature", path: "/repo/.aimux/worktrees/feature", branch: "feature" }],
      supervisorLane: {
        sessions: [
          session({
            id: "scribe",
            role: "scribe",
            lane: { kind: "supervisor" },
            roleState: {
              status: "resolved",
              role: "scribe",
              lane: { kind: "supervisor" },
              projectControl: true,
              shouldShowInExpose: false,
              exposeOrder: 1000,
            },
            projectControl: true,
          }),
          session({
            id: "overseer",
            role: "overseer",
            lane: { kind: "supervisor" },
            roleState: {
              status: "resolved",
              role: "overseer",
              lane: { kind: "supervisor" },
              projectControl: true,
              shouldShowInExpose: true,
              exposeOrder: 0,
            },
            projectControl: true,
          }),
        ],
      },
      sessions: [
        session({ id: "main-agent", worktreePath: "/repo" }),
        session({ id: "worker-agent", worktreePath: "/repo/.aimux/worktrees/feature" }),
      ],
      services: [],
    };

    const [supervisor, main, feature] = groupByWorktree(state);

    expect(supervisor?.sessions.map((item) => item.id)).toEqual(["overseer", "scribe"]);
    expect(main?.sessions.map((item) => item.id)).toEqual(["main-agent"]);
    expect(feature?.sessions.map((item) => item.id)).toEqual(["worker-agent"]);
  });
});
