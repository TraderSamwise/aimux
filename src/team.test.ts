import { describe, expect, it } from "vitest";
import { selectOrphanTeammates } from "./team.js";

describe("selectOrphanTeammates", () => {
  it("returns only teammate sessions whose parent id is not known", () => {
    const sessions = [
      { id: "primary", createdAt: "2026-05-01T00:00:00.000Z" },
      {
        id: "attached",
        createdAt: "2026-05-01T00:00:00.000Z",
        team: { teamId: "team-1", parentSessionId: "primary" },
      },
      {
        id: "orphan",
        createdAt: "2026-05-02T00:00:00.000Z",
        team: { teamId: "team-1", parentSessionId: "missing" },
      },
      {
        id: "ordered-orphan",
        createdAt: "2026-05-03T00:00:00.000Z",
        team: { teamId: "team-1", parentSessionId: "missing", order: 0 },
      },
      {
        id: "orphan",
        createdAt: "2026-05-04T00:00:00.000Z",
        team: { teamId: "team-1", parentSessionId: "missing", order: 10 },
      },
    ];

    expect(selectOrphanTeammates(sessions, ["primary"]).map((session) => session.id)).toEqual([
      "ordered-orphan",
      "orphan",
    ]);
  });
});
