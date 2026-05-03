import { describe, expect, it } from "vitest";
import { collectGithubPrTargets } from "./gh-pr-context.js";

describe("collectGithubPrTargets", () => {
  it("ignores stale metadata-only sessions", () => {
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
    );

    expect(targets).toEqual([
      { id: "live-from-statusline", worktreePath: "/repo/live" },
      { id: "live-from-state", worktreePath: "/repo/state" },
      { id: "service-1", worktreePath: "/repo/service" },
    ]);
  });

  it("uses metadata context only to complete live session paths", () => {
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
        },
      },
    );

    expect(targets).toEqual([
      { id: "statusline-missing-path", worktreePath: "/repo/statusline" },
      { id: "state-missing-path", worktreePath: "/repo/state" },
    ]);
  });
});
