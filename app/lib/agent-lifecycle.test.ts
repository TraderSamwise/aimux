import { describe, expect, it } from "vitest";

import { canResumeSession } from "./agent-lifecycle";

describe("canResumeSession", () => {
  it("allows offline sessions unless the API marks restore blocked", () => {
    expect(canResumeSession({ status: "offline" })).toBe(true);
    expect(canResumeSession({ status: "exited", restoreState: "ready" })).toBe(true);
  });

  it("blocks resume for sessions without an exact backend resume id", () => {
    expect(canResumeSession({ status: "offline", restoreState: "blocked" })).toBe(false);
  });

  it("does not offer resume for running sessions", () => {
    expect(canResumeSession({ status: "running", restoreState: "ready" })).toBe(false);
  });
});
