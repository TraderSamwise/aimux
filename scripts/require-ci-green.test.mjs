import { describe, expect, it } from "vitest";

import { classifyRuns } from "./require-ci-green.mjs";

const completed = (conclusion) => ({ status: "completed", conclusion, url: `https://x/${conclusion}` });
const running = () => ({ status: "in_progress", conclusion: null, url: "https://x/running" });

describe("require a green ci run for the tagged commit", () => {
  it("refuses to publish when ci failed on this commit", () => {
    expect(classifyRuns([completed("success"), completed("failure")]).verdict).toBe("failed");
  });

  it("refuses while no ci run for this commit exists yet", () => {
    expect(classifyRuns([]).verdict).toBe("waiting");
  });

  it("refuses while a ci run for this commit is still going", () => {
    expect(classifyRuns([completed("success"), running()]).verdict).toBe("waiting");
  });

  // A tag push lands the branch and the tag together, so the same commit gets
  // two ci runs. ci cancels superseded runs by ref, so a cancelled run is not
  // evidence the commit is bad -- but it is not evidence it is good either.
  it("accepts a green run beside a cancelled one", () => {
    expect(classifyRuns([completed("success"), completed("cancelled")]).verdict).toBe("green");
  });

  it("does not treat a cancelled run on its own as permission to publish", () => {
    expect(classifyRuns([completed("cancelled")]).verdict).toBe("waiting");
  });

  it("names every failing run so the tag says which one to look at", () => {
    const { failed } = classifyRuns([completed("failure"), completed("timed_out")]);
    expect(failed.map((run) => run.conclusion)).toEqual(["failure", "timed_out"]);
  });
});
