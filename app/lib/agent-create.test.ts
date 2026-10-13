import { describe, expect, it } from "vitest";

import type { WorktreeBucket } from "@/lib/desktop-state";
import {
  AGENT_TOOL_CHOICES,
  CREATION_REFRESH_VIEWS,
  canSubmitCreation,
  creatableWorktreeChoices,
  isSelectableWorktreePath,
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
  it("refreshes every list a new agent appears in", () => {
    // Not just the worktree it landed in: an agent shows up in the agent list,
    // the topology, the team and the coordination worklist too, and a
    // creation that refreshes only one leaves the rest stale.
    for (const view of ["agents", "topology", "team", "coordination-worklist", "worktrees"]) {
      expect(CREATION_REFRESH_VIEWS).toContain(view);
    }
  });

  it("offers the runtimes an agent can be", () => {
    expect(AGENT_TOOL_CHOICES).toContain("claude");
    expect(AGENT_TOOL_CHOICES).toContain("codex");
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
