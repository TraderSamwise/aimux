import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The agent list is where the reopen can happen, and the only place.
 *
 * It is the one screen that knows which agents exist, which is the whole
 * reason the decision can be made safely: an agent that is gone opens on
 * "Agent unavailable", a worse first screen than the list. What source can
 * still say is that this screen delegates the decision and does it once --
 * the rules themselves are driven in `reopen-last-agent.test.ts`.
 */
const dashboardSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "WorktreeDashboard.tsx"),
  "utf8",
);

const projectsStoreSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "stores", "projects.ts"),
  "utf8",
);

describe("reopening the last agent", () => {
  it("asks the rule rather than deciding here", () => {
    expect(dashboardSource).toContain("lastAgentToReopen({");
    expect(dashboardSource).toContain("rememberedAgentForProject(lastAgentByProject,");
    // The list it checks against must be the agents actually listed; a screen
    // that passed an empty array would never reopen anything, and one that
    // skipped the check would open a dead agent.
    expect(dashboardSource).toMatch(/listedSessionIds: groups\.flatMap\([\s\S]*?session\.id\)/);
  });

  it("asks the launch whether it has already done this", () => {
    // Hardcoding `false` here passes every other assertion and reopens the
    // chat on every mount, which is the one way this feature becomes hateful.
    // The ref beside it only guards one mount; the module flag is what makes
    // it once per launch.
    expect(dashboardSource).toContain("alreadyReopened: reopenedLastAgentThisLaunch(),");
    expect(dashboardSource).toContain("reopenedThisLaunchRef.current || !desktopStatePresent");
  });

  it("opens it the way a tap does, so it lands in one place", () => {
    // `handlePickSession` selects the agent and pushes the chat. A second
    // navigation path here would be a second answer to "how do I open a chat".
    expect(dashboardSource).toMatch(/if \(!target\) return;\s*\n\s*handlePickSession\(target\);/);
  });

  it("marks the launch before it navigates, and whatever it decides", () => {
    // Marked even when there was nowhere to go: the list fills in over a
    // second or two, and a later tick must not yank the user then.
    expect(dashboardSource).toMatch(/markLastAgentReopened\(\);\s*\n\s*if \(!target\) return;/);
  });

  it("waits for the state to be present before concluding the agent is gone", () => {
    // Before the first desktop state arrives every agent looks absent, and
    // concluding "gone" there would spend the launch's one attempt on nothing.
    expect(dashboardSource).toContain("!desktopStatePresent) return;");
  });
});

describe("the memory behind it", () => {
  it("is durable, and keyed by project", () => {
    expect(projectsStoreSource).toContain('"aimux-last-agent-by-project"');
    expect(projectsStoreSource).toContain("getOnInit: true");
  });

  it("is written where the selection is made, not at its call sites", () => {
    // Twenty-nine places set the selected agent. The memory is recorded in the
    // setter so none of them can forget to.
    expect(projectsStoreSource).toContain("rememberAgentForProject(");
    const setter = projectsStoreSource.slice(
      projectsStoreSource.indexOf("export const selectedSessionIdAtom = atom("),
    );
    expect(setter.slice(0, 900)).toContain("set(selectedSessionIdValueAtom, sessionId)");
    expect(setter.slice(0, 900)).toContain("rememberAgentForProject(");
  });
});
