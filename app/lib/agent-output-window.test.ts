import { describe, expect, it } from "vitest";
import { agentOutputHistoryFloorNotice, agentOutputWindowOmitsHead } from "./agent-output-window";

/**
 * `outputTailOnly` is true for every window this app asks for -- it requests a
 * negative start line and the service sets the flag on `start_line < 0` -- so
 * the service's fact alone cannot decide whether to say anything.
 */
describe("the window the service served", () => {
  it("reports a tail or a clamped request as missing its head", () => {
    expect(agentOutputWindowOmitsHead({ tailOnly: true })).toBe(true);
    expect(agentOutputWindowOmitsHead({ startLineClamped: true })).toBe(true);
  });

  it("reports nothing for a window that carried the whole pane", () => {
    expect(agentOutputWindowOmitsHead(undefined)).toBe(false);
    expect(agentOutputWindowOmitsHead({})).toBe(false);
    expect(agentOutputWindowOmitsHead({ tailOnly: false, startLineClamped: false })).toBe(false);
  });
});

describe("why scrolling up stopped", () => {
  const tail = { tailOnly: true, captureLineLimit: 2000 };

  // The whole reason this is not the TUI's rule: before the floor, scrolling
  // up fetches another page, so a notice would be noise on every chat.
  it("says nothing while there are more pages to fetch", () => {
    expect(agentOutputHistoryFloorNotice(tail, false)).toBeNull();
  });

  it("explains the floor once the view has reached it", () => {
    expect(agentOutputHistoryFloorNotice(tail, true)).toBe(
      "Earlier output is not loaded · this view goes back 2000 lines",
    );
  });

  // A window that carried the whole pane has no head to be missing, floor or
  // not -- so a short session never gets told output was dropped.
  it("says nothing when the window was not a tail", () => {
    expect(agentOutputHistoryFloorNotice({ captureLineLimit: 2000 }, true)).toBeNull();
  });

  // Naming a number nobody sent would be inventing one.
  it("drops the number rather than guess it", () => {
    expect(agentOutputHistoryFloorNotice({ tailOnly: true }, true)).toBe(
      "Earlier output is not loaded",
    );
    expect(agentOutputHistoryFloorNotice({ tailOnly: true, captureLineLimit: 0 }, true)).toBe(
      "Earlier output is not loaded",
    );
  });
});
