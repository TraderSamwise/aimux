import { describe, expect, it } from "vitest";
import { updateShareServiceEndpoints, type SharedSessionRecord, type SharingState } from "./sharing";

// A report is work inside the one durable object that answers everything for
// an account, so its cost is a correctness property and not a nicety: while it
// runs, every other request for that account waits.
describe("the cost of one project endpoint report", () => {
  function seededState(shareCount: number, invitesPerShare: number): SharingState {
    const shares: Record<string, SharedSessionRecord> = {};
    for (let index = 0; index < shareCount; index += 1) {
      const id = `share_${index}`;
      const invites = Object.fromEntries(
        Array.from({ length: invitesPerShare }, (_unused, inviteIndex) => [
          `invite_${inviteIndex}`,
          {
            id: `invite_${inviteIndex}`,
            shareId: id,
            email: `guest${inviteIndex}@example.com`,
            tokenHash: "hash",
            status: "accepted" as const,
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-12-31T00:00:00.000Z",
          },
        ]),
      );
      shares[id] = {
        id,
        ownerUserId: "user_owner",
        projectRoot: `/cs/project-${index}`,
        serviceEndpoint: { host: "127.0.0.1", port: 40000 + index },
        machineId: "mini",
        sessionId: `claude-${index}`,
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
        version: 1,
        participants: {},
        invites,
      };
    }
    return { version: 1, shares, acceptedShares: {} };
  }

  function reportMs(state: SharingState, entryCount: number): number {
    const endpoints = Array.from({ length: entryCount }, (_unused, index) => ({
      projectRoot: `/cs/nothing-${index}`,
      serviceEndpoint: { host: "127.0.0.1", port: 50000 + index },
    }));
    const started = performance.now();
    const result = updateShareServiceEndpoints(state, {
      ownerUserId: "user_owner",
      machineId: "mini",
      endpoints,
    });
    const elapsedMs = performance.now() - started;
    expect(result.updated).toEqual([]);
    return elapsedMs;
  }

  it("stays flat as the report grows, instead of normalizing once per project", () => {
    const state = seededState(200, 50);
    // Measured against itself rather than a wall-clock budget: the cost of one
    // report on a shared machine is not predictable, but the SHAPE is. The bug
    // normalized all 200 shares and all 10,000 invites once per entry, so the
    // five-hundredth entry cost as much as the first -- 11.8 seconds for a
    // report that matched nothing, and 135ms for the fifty entries a real
    // machine reports every thirty seconds.
    const onceEach = Array.from({ length: 20 }, () => reportMs(state, 1));
    const single = Math.min(...onceEach);
    const manyMs = reportMs(state, 500);

    expect(manyMs, `500 entries took ${manyMs.toFixed(1)}ms against ${single.toFixed(1)}ms for one`).toBeLessThan(
      single * 20 + 20,
    );
  });
});
