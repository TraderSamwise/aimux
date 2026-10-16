import { describe, expect, it } from "vitest";

import {
  lastAgentToReopen,
  markLastAgentReopened,
  rememberAgentForProject,
  rememberedAgentForProject,
  reopenedLastAgentThisLaunch,
  resetLastAgentReopenedForTest,
} from "@/lib/reopen-last-agent";
import { agentSessionIdInPath } from "@/lib/view-location";

const base = {
  remembered: "claude-7",
  listedSessionIds: ["claude-7", "codex-2"],
  alreadyReopened: false,
} as const;

describe("reopening the agent you were last reading", () => {
  it("reopens the remembered agent on the first look of a launch", () => {
    expect(lastAgentToReopen(base)).toBe("claude-7");
  });

  // The failure that would make this feature hateful: backing out of a chat
  // and being thrown straight back into it.
  it("does it once per launch, not once per mount", () => {
    expect(lastAgentToReopen({ ...base, alreadyReopened: true })).toBeNull();
  });

  // "Agent unavailable / not found" is a worse first screen than the list.
  it("does not send anyone to an agent that is gone", () => {
    expect(lastAgentToReopen({ ...base, listedSessionIds: ["codex-2"] })).toBeNull();
    expect(lastAgentToReopen({ ...base, listedSessionIds: [] })).toBeNull();
  });

  it("has nothing to do when nothing is remembered", () => {
    expect(lastAgentToReopen({ ...base, remembered: null })).toBeNull();
    expect(lastAgentToReopen({ ...base, remembered: undefined })).toBeNull();
    expect(lastAgentToReopen({ ...base, remembered: "   " })).toBeNull();
  });

  // A notification tap, a shared link, a deep link: the user named an agent,
  // and a memory that redirected it would be the bug 947602-122 just fixed in
  // another form.
  it("never outranks an agent the route names", () => {
    expect(lastAgentToReopen({ ...base, routeSessionId: "codex-2" })).toBeNull();
  });
});

describe("the memory is per project", () => {
  it("answers for the project asked about", () => {
    const memory = { "a|/repo": "claude-1", "b|/repo": "codex-9" };
    expect(rememberedAgentForProject(memory, "a|/repo")).toBe("claude-1");
    expect(rememberedAgentForProject(memory, "b|/repo")).toBe("codex-9");
    // The same checkout on two machines is two projects, which is why the key
    // is a project key and not a path.
    expect(rememberedAgentForProject(memory, "c|/repo")).toBeNull();
    expect(rememberedAgentForProject(memory, null)).toBeNull();
    expect(rememberedAgentForProject({}, "a|/repo")).toBeNull();
  });

  it("records a selection against its project", () => {
    expect(rememberAgentForProject({}, "a|/repo", "claude-1")).toEqual({ "a|/repo": "claude-1" });
    expect(rememberAgentForProject({ "a|/repo": "claude-1" }, "b|/repo", "codex-9")).toEqual({
      "a|/repo": "claude-1",
      "b|/repo": "codex-9",
    });
  });

  // The transient selection is cleared to null whenever the open project
  // changes. Forgetting at that moment would defeat the whole point: the next
  // launch is exactly when this is read.
  it("does not forget when the selection is merely cleared", () => {
    const memory = { "a|/repo": "claude-1" };
    expect(rememberAgentForProject(memory, "a|/repo", null)).toEqual(memory);
    expect(rememberAgentForProject(memory, "a|/repo", "")).toEqual(memory);
    expect(rememberAgentForProject(memory, null, "claude-2")).toEqual(memory);
  });

  it("returns the same object when nothing changed, so no write is triggered", () => {
    const memory = { "a|/repo": "claude-1" };
    expect(rememberAgentForProject(memory, "a|/repo", "claude-1")).toBe(memory);
    expect(rememberAgentForProject(memory, "a|/repo", null)).toBe(memory);
  });
});

describe("one reopen per launch", () => {
  // Module state, not a store atom: it must NOT survive a relaunch, and it
  // must not be something a screen can forget to reset.
  it("starts unmarked, marks once, and stays marked", () => {
    resetLastAgentReopenedForTest();
    expect(reopenedLastAgentThisLaunch()).toBe(false);
    markLastAgentReopened();
    expect(reopenedLastAgentThisLaunch()).toBe(true);
    markLastAgentReopened();
    expect(reopenedLastAgentThisLaunch()).toBe(true);
    resetLastAgentReopenedForTest();
  });

  // The sequence the screen actually drives: the list arrives, the agent is
  // reopened, and a later tick -- the same list, polled again -- must not
  // reopen it a second time after the user has navigated away.
  it("does not fire again when the list ticks", () => {
    resetLastAgentReopenedForTest();
    const look = () =>
      lastAgentToReopen({
        remembered: "claude-7",
        listedSessionIds: ["claude-7"],
        alreadyReopened: reopenedLastAgentThisLaunch(),
      });
    expect(look()).toBe("claude-7");
    markLastAgentReopened();
    expect(look()).toBeNull();
    expect(look()).toBeNull();
    resetLastAgentReopenedForTest();
  });
});

describe("the agent a path is already showing", () => {
  it("reads the id out of a chat route", () => {
    expect(agentSessionIdInPath("/agent/claude-7/chat")).toBe("claude-7");
    expect(agentSessionIdInPath("/shares/u1/s1/agent/codex-2/chat")).toBe("codex-2");
    expect(agentSessionIdInPath("/agent/claude%2F7/chat")).toBe("claude/7");
  });

  it("has nothing to say about a route showing no agent", () => {
    expect(agentSessionIdInPath("/project")).toBeNull();
    expect(agentSessionIdInPath("/project?project=%2Frepo")).toBeNull();
    expect(agentSessionIdInPath("")).toBeNull();
    expect(agentSessionIdInPath(null)).toBeNull();
    expect(agentSessionIdInPath(undefined)).toBeNull();
    // The segment has to be an id, not the route template or an empty one.
    expect(agentSessionIdInPath("/agent//chat")).toBeNull();
  });

  // Together: a user already in a chat is left alone, whatever is remembered.
  it("stops a remembered agent from redirecting a chat that is already open", () => {
    expect(
      lastAgentToReopen({
        remembered: "claude-7",
        listedSessionIds: ["claude-7", "codex-2"],
        alreadyReopened: false,
        routeSessionId: agentSessionIdInPath("/agent/codex-2/chat"),
      }),
    ).toBeNull();
    // And on the list, with no agent in the path, it does its job.
    expect(
      lastAgentToReopen({
        remembered: "claude-7",
        listedSessionIds: ["claude-7", "codex-2"],
        alreadyReopened: false,
        routeSessionId: agentSessionIdInPath("/project"),
      }),
    ).toBe("claude-7");
  });
});
