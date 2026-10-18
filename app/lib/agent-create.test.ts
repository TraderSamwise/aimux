import { describe, expect, it } from "vitest";

import type { WorktreeBucket } from "@/lib/desktop-state";
import {
  AGENT_TOOL_CHOICES,
  agentCreationRole,
  agentCreationPolicyIsAvailable,
  AGENT_CREATION_REFRESH_VIEWS,
  WORKTREE_CREATION_REFRESH_VIEWS,
  canSubmitCreation,
  choicesIncludingJustCreated,
  creatableWorktreeChoices,
  isSelectableWorktreePath,
  removableWorktreeChoices,
  worktreeNameIsCreatable,
} from "./agent-create";

function bucket(overrides: Partial<WorktreeBucket>): WorktreeBucket {
  return {
    key: "wt",
    name: "wt",
    branch: "feat/wt",
    path: "/repo/.aimux/worktrees/wt",
    isMainCheckout: false,
    sessions: [],
    services: [],
    ...overrides,
  };
}

describe("where a new agent can be launched", () => {
  it("offers an ordinary worktree", () => {
    const choices = creatableWorktreeChoices([bucket({ key: "a", name: "alpha" })]);
    expect(choices).toEqual([{ key: "a", label: "alpha", path: "/repo/.aimux/worktrees/wt" }]);
  });

  // The main checkout is offered separately as its own choice, so listing it
  // here would show it twice.
  it("leaves the main checkout to be offered on its own", () => {
    expect(creatableWorktreeChoices([bucket({ isMainCheckout: true })])).toEqual([]);
  });

  // Each of these is a bucket an agent cannot actually be launched into, and
  // offering it produces a failure the person could not have predicted.
  it("refuses the buckets that are not a usable checkout", () => {
    expect(creatableWorktreeChoices([bucket({ isSupervisorLane: true })])).toEqual([]);
    expect(creatableWorktreeChoices([bucket({ pathMissing: true })])).toEqual([]);
    expect(creatableWorktreeChoices([bucket({ pending: true })])).toEqual([]);
    expect(creatableWorktreeChoices([bucket({ removing: true })])).toEqual([]);
    expect(creatableWorktreeChoices([bucket({ path: null })])).toEqual([]);
  });

  // A worktree can be removed while a form sits open: sending its path would
  // launch into something that is no longer there.
  it("stops offering a path once it leaves the choices", () => {
    const choices = creatableWorktreeChoices([bucket({ path: "/repo/wt-a" })]);
    expect(isSelectableWorktreePath(choices, "/repo/wt-a")).toBe(true);
    expect(isSelectableWorktreePath(choices, "/repo/wt-gone")).toBe(false);
    // null is the main checkout, which is always there.
    expect(isSelectableWorktreePath([], null)).toBe(true);
  });
});

describe("a worktree that was just created", () => {
  // It is `pending` for the moment between the create returning and the
  // refresh arriving, and pending buckets are not launch targets -- so
  // offering it as the place to put an agent silently fell back to the main
  // checkout, which is the opposite of what was just asked for.
  it("stays a choice while it has not landed yet", () => {
    const choices = choicesIncludingJustCreated([], [], { name: "feat/new", path: "/repo/wt-new" });
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ label: "feat/new", path: "/repo/wt-new" });
  });

  it("does not become a duplicate once the real bucket arrives", () => {
    const landed = [bucket({ key: "a", name: "feat/new", path: "/repo/wt-new" })];
    const choices = choicesIncludingJustCreated(landed, creatableWorktreeChoices(landed), {
      name: "feat/new",
      path: "/repo/wt-new",
    });
    expect(choices).toHaveLength(1);
    expect(choices[0].key).toBe("a");
  });

  // Once its bucket has arrived, that bucket decides. A worktree that landed
  // and is already being removed, or whose directory turned out to be missing,
  // must not be put back on the list by the memory of having created it.
  it("does not restore one that landed and then became ineligible", () => {
    const removing = [bucket({ key: "a", name: "feat/new", path: "/repo/wt-new", removing: true })];
    const choices = choicesIncludingJustCreated(removing, creatableWorktreeChoices(removing), {
      name: "feat/new",
      path: "/repo/wt-new",
    });
    expect(choices).toEqual([]);
  });

  it("changes nothing when there is none", () => {
    const landed = [bucket({ key: "a" })];
    const real = creatableWorktreeChoices(landed);
    expect(choicesIncludingJustCreated(landed, real, null)).toEqual(real);
  });
});

describe("which worktrees can be removed", () => {
  it("needs the worktree to be empty", () => {
    const empty = bucket({ key: "a", name: "alpha" });
    expect(removableWorktreeChoices([empty])).toHaveLength(1);
    expect(removableWorktreeChoices([{ ...empty, sessions: [{ id: "s" } as never] }])).toEqual([]);
    expect(removableWorktreeChoices([{ ...empty, services: [{ id: "v" } as never] }])).toEqual([]);
  });

  // The rule that makes this a different question from "where can an agent
  // go": a worktree whose directory is gone is the one you most want to be
  // able to remove, and the last place you would launch anything.
  it("keeps a worktree whose directory is gone, where launching would not", () => {
    const gone = bucket({ pathMissing: true });
    expect(removableWorktreeChoices([gone])).toHaveLength(1);
    expect(creatableWorktreeChoices([gone])).toEqual([]);
  });
});

describe("what the route will accept as a worktree name", () => {
  it("needs a name that is not just space", () => {
    expect(worktreeNameIsCreatable("feat/thing")).toBe(true);
    expect(worktreeNameIsCreatable("")).toBe(false);
    expect(worktreeNameIsCreatable("   ")).toBe(false);
    // Trimmed, the same way the route trims it, so a padded name is accepted
    // here and accepted there.
    expect(worktreeNameIsCreatable("  feat/thing  ")).toBe(true);
  });
});

describe("what a creation changes", () => {
  // Asserted as an exact set, not a subset: a `toContain` list let an entry be
  // deleted and a bogus one added without anything failing, and a view key
  // that does not exist refreshes nothing silently.
  it("refreshes exactly the lists a new agent appears in", () => {
    expect([...AGENT_CREATION_REFRESH_VIEWS].sort()).toEqual([
      "agents",
      "coordination-worklist",
      "project-observability",
      "team",
      "topology",
      "worktrees",
    ]);
  });

  // A different set, not the same one. Sending the agent list for a worktree
  // left the library stale, which is how two surfaces showing the same project
  // started to disagree.
  it("refreshes exactly the lists a new worktree appears in", () => {
    expect([...WORKTREE_CREATION_REFRESH_VIEWS].sort()).toEqual([
      "graveyard",
      "library",
      "project-observability",
      "topology",
      "worktrees",
    ]);
  });

  it("offers exactly the runtimes an agent can be", () => {
    // Also an exact set: dropping one silently removes a chip from every
    // surface at once, which is the cost of deriving it in one place.
    expect([...AGENT_TOOL_CHOICES]).toEqual(["claude", "codex", "aider"]);
  });
});

describe("when the create button does something", () => {
  const base = { kind: "agent" as const, hasEndpoint: true, busy: false, name: "" };

  // An agent needs no name: its tool and its worktree both have a default, so
  // the button is live the moment the dialog opens.
  it("lets an agent be launched with nothing typed", () => {
    expect(canSubmitCreation(base)).toBe(true);
  });

  // A worktree does, and sending a blank one just earns a 400 from the route.
  it("waits for a worktree name", () => {
    expect(canSubmitCreation({ ...base, kind: "worktree" })).toBe(false);
    expect(canSubmitCreation({ ...base, kind: "worktree", name: "   " })).toBe(false);
    expect(canSubmitCreation({ ...base, kind: "worktree", name: "feat/x" })).toBe(true);
  });

  // Nothing can be created against a host that is not there, and a second tap
  // while the first is in flight launches twice.
  it("refuses with no host and refuses while one is in flight", () => {
    expect(canSubmitCreation({ ...base, hasEndpoint: false })).toBe(false);
    expect(canSubmitCreation({ ...base, busy: true })).toBe(false);
    expect(canSubmitCreation({ ...base, kind: "worktree", name: "feat/x", busy: true })).toBe(
      false,
    );
  });
});

describe("service agent creation policy", () => {
  const policy = {
    defaultTarget: "supervisor" as const,
    defaultRole: "control",
    worktreeRole: "coder",
  };

  it("uses the service target by default and honors an explicit worktree choice", () => {
    expect(agentCreationRole(policy)).toBe("control");
    expect(agentCreationRole(policy, "worktree")).toBe("coder");
    expect(agentCreationRole({ ...policy, defaultTarget: "worktree" })).toBe("coder");
    expect(agentCreationRole({ ...policy, defaultRole: "planner" })).toBe("planner");
  });

  it("blocks missing or incomplete policy without guessing a target", () => {
    expect(agentCreationPolicyIsAvailable(policy)).toBe(true);
    for (const invalid of [
      undefined,
      null,
      { defaultRole: "control", worktreeRole: "coder" },
      { ...policy, defaultTarget: "unknown" },
      { ...policy, defaultRole: "" },
    ]) {
      expect(agentCreationPolicyIsAvailable(invalid as never)).toBe(false);
      expect(() => agentCreationRole(invalid as never)).toThrow(
        "Agent creation policy is unavailable",
      );
    }
  });
});
