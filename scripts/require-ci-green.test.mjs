import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyRuns, parseOptions } from "./require-ci-green.mjs";

const WORKFLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "release.yml"),
  "utf8",
);

// The argv the workflow actually builds, read out of the workflow rather than
// retyped here: the gate shipped parsing only `--key=value`, the workflow passes
// `--key value`, and v0.1.60 died on the usage message with both ci runs green.
function workflowArgv() {
  const invocation = WORKFLOW.match(/node scripts\/require-ci-green\.mjs((?:[^\n]*\\\n)*[^\n]*)/);
  if (!invocation) throw new Error("release.yml no longer invokes require-ci-green.mjs");
  // Substitute the expressions before splitting: `${{ github.repository }}`
  // carries spaces of its own and would otherwise become three arguments.
  return invocation[1]
    .replace(/\\\n/g, " ")
    .replace(/\$\{\{[^}]*github\.repository[^}]*\}\}/g, "TraderSamwise/aimux")
    .replace(/\$\{\{[^}]*github\.sha[^}]*\}\}/g, "d353093a")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^"|"$/g, ""));
}

describe("the gate parses the arguments the workflow gives it", () => {
  it("reads the release workflow's own invocation", () => {
    const options = parseOptions(workflowArgv());
    expect(options.repo).toBe("TraderSamwise/aimux");
    expect(options.sha).toBe("d353093a");
  });

  it("still reads the equals form", () => {
    expect(parseOptions(["--repo=owner/name", "--sha=abc", "--workflow=ci.yml"])).toEqual({
      repo: "owner/name",
      sha: "abc",
      workflow: "ci.yml",
    });
  });

  it("does not swallow the next flag as a value", () => {
    expect(parseOptions(["--repo", "--sha", "abc"])).toEqual({ repo: "", sha: "abc" });
  });
});

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
