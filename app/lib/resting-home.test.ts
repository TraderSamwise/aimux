import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { restingHomeParams, restingHomeTarget } from "./resting-home";

const TOP_BAR = readFileSync(join(__dirname, "..", "components", "TopBar.tsx"), "utf8");

describe("the resting home target", () => {
  it("is the selected project", () => {
    expect(
      restingHomeTarget({
        selectedProject: { path: "/Users/sam/cs/aimux", machineId: "mini" },
        activeShare: null,
        userId: "user_1",
      }),
    ).toEqual({ path: "/Users/sam/cs/aimux", machineId: "mini" });
  });

  it("follows a share only when the viewer owns it", () => {
    // A share I own is my own project seen from outside, so home is that
    // project. Someone else's share is not my project at all, and following
    // its root would send me to an overview I cannot load.
    expect(
      restingHomeTarget({
        selectedProject: { path: "/mine" },
        activeShare: { ownerUserId: "user_1", projectRoot: "/shared-out" },
        userId: "user_1",
      }),
    ).toEqual({ path: "/shared-out" });
    expect(
      restingHomeTarget({
        selectedProject: { path: "/mine" },
        activeShare: { ownerUserId: "user_2", projectRoot: "/someone-elses" },
        userId: "user_1",
      }),
    ).toEqual({ path: "/mine" });
  });

  it("resolves to the project list when nothing is selected", () => {
    const target = restingHomeTarget({
      selectedProject: null,
      activeShare: null,
      userId: null,
    });
    expect(restingHomeParams(target)).toEqual({});
  });

  it("carries the machine only when there is one", () => {
    expect(restingHomeParams({ path: "/p", machineId: "mini" })).toEqual({
      project: "/p",
      machine: "mini",
    });
    expect(restingHomeParams({ path: "/p" })).toEqual({ project: "/p" });
    expect(restingHomeParams({ path: "   " })).toEqual({});
  });
});

describe("the two surfaces that ask where home is", () => {
  // The logo and the Projects tab. They need different route spellings -- the
  // tab switches tabs and takes the group-qualified path, the logo is pressed
  // from `/agent/...` and takes the public one -- but they must not each
  // decide WHICH project home is.
  it("both read the target from the shared helper", () => {
    expect((TOP_BAR.match(/restingHomeTarget\(/g) ?? []).length).toBe(2);
  });

  it("neither re-derives the share-ownership rule", () => {
    // This conditional was the rule, written inline. If it reappears, one
    // surface has its own answer again.
    expect(TOP_BAR).not.toMatch(/ownerUserId === userId/);
  });

  it("the logo is a real link to the public route", () => {
    // Two things were measured, both by clicking and watching the URL not
    // change: `router.navigate` to `/(main)/(tabs)/project` does nothing from
    // an agent chat, because that path switches tabs inside the tab navigator
    // and the chat is not in it; and `router.navigate` to the public
    // `/project` did not move either. A Link renders an anchor the browser
    // follows, and also gets cmd-click for free.
    expect(TOP_BAR).toMatch(/<Link\s/);
    expect(TOP_BAR).toMatch(/pathname: "\/project", params: homeParams/);
  });
});
