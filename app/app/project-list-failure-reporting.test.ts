import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The reported bug: the GUI showed "No projects detected" while five dashboards
// were running, because every failure path in the poll loop ended in an empty
// list and a console.warn. A unit test on the helpers cannot catch that coming
// back -- only the loop itself can.
const layout = readFileSync(join(__dirname, "(main)", "_layout.tsx"), "utf8");

function projectPollLoop(): string {
  const start = layout.indexOf("Poll /projects as a discovery fallback");
  expect(start, "the project poll loop moved; update this guard").toBeGreaterThan(-1);
  const end = layout.indexOf("useEffect(", layout.indexOf("void loop();", start));
  return layout.slice(start, end === -1 ? undefined : end);
}

describe("the project poll loop never reports a failure as zero projects", () => {
  it("reports the relay being unavailable instead of emptying the list", () => {
    const loop = projectPollLoop();
    const branch = loop.slice(
      loop.indexOf("isRelayUnavailableForProjectDiscovery"),
      loop.indexOf("try {"),
    );
    expect(branch).toContain("setProjectListStatus");
    expect(branch, "an unreachable relay is not an answer of zero projects").not.toContain(
      "reconcileProjects([])",
    );
  });

  it("surfaces every non-transient error rather than only logging it", () => {
    const loop = projectPollLoop();
    const handler = loop.slice(loop.indexOf("} catch (err) {"));
    expect(handler).toContain("setProjectListStatus");
    expect(handler, "a warning in the console is not a visible outcome").not.toContain(
      "console.warn",
    );
  });

  it("still tells the user when the daemon itself is offline", () => {
    const loop = projectPollLoop();
    const handler = loop.slice(loop.indexOf("isProjectHostOfflineError"));
    expect(handler).toContain("projectListUnavailable");
  });
});
