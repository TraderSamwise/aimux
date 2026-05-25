import { describe, expect, it } from "vitest";
import { collectGithubPrTargets } from "./gh-pr-context.js";

describe("collectGithubPrTargets", () => {
  it("ignores stale statusline, state, and metadata-only agent sessions", () => {
    const targets = collectGithubPrTargets(
      {
        sessions: [{ id: "live-from-statusline", worktreePath: "/repo/live" }],
      },
      {
        sessions: [{ id: "live-from-state", worktreePath: "/repo/state" }],
        services: [{ id: "service-1", worktreePath: "/repo/service" }],
      },
      {
        sessions: {
          "metadata-only-old-agent": {
            context: { worktreePath: "/repo/stale" },
          },
        },
      },
      [{ id: "live-from-topology", worktreePath: "/repo/topology" } as any],
    );

    expect(targets).toEqual([
      { id: "live-from-topology", worktreePath: "/repo/topology" },
      { id: "service-1", worktreePath: "/repo/service" },
    ]);
  });

  it("uses statusline and metadata context only to complete topology session paths", () => {
    const targets = collectGithubPrTargets(
      {
        sessions: [{ id: "statusline-missing-path" }],
      },
      {
        sessions: [{ id: "state-missing-path" }],
      },
      {
        sessions: {
          "statusline-missing-path": {
            context: { cwd: "/repo/statusline" },
          },
          "state-missing-path": {
            context: { worktreePath: "/repo/state" },
          },
          "topology-missing-path": {
            context: { worktreePath: "/repo/topology" },
          },
        },
      },
      [{ id: "statusline-missing-path" } as any, { id: "topology-missing-path" } as any],
    );

    expect(targets).toEqual([
      { id: "statusline-missing-path", worktreePath: "/repo/statusline" },
      { id: "topology-missing-path", worktreePath: "/repo/topology" },
    ]);
  });
});
