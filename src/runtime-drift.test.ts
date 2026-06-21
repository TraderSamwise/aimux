import { describe, expect, it } from "vitest";
import { isAimuxBuildDriftError } from "./runtime-drift.js";

describe("isAimuxBuildDriftError", () => {
  it("matches daemon and project service local build drift errors", () => {
    expect(isAimuxBuildDriftError(new Error("aimux daemon on default port is from a different local build"))).toBe(
      true,
    );
    expect(isAimuxBuildDriftError(new Error("the running project service is from a different local build"))).toBe(true);
  });

  it("ignores unrelated readiness failures", () => {
    expect(isAimuxBuildDriftError(new Error("aimux daemon is not running"))).toBe(false);
    expect(isAimuxBuildDriftError("different local build")).toBe(false);
  });
});
