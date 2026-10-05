import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { deriveAgentState } from "@/lib/agent-status-label";
import type { DesktopSession } from "@/lib/desktop-state";
import {
  TRANSIENT_ACTIONS,
  pendingActionLabel,
  pendingActionStatusKind,
  serviceStatusKind,
} from "@/lib/status-tone";

// The app half of the cross-surface transient-state check. AGENTS.md "One
// Answer, Many Surfaces": a per-surface test passes happily while the surfaces
// disagree, and these two disagreed with themselves -- the TUI painted every
// in-flight action `Tone::Attention` and the app returned the `needs` token,
// which are each surface's "a person must act" colour.
//
// The TUI reads this same file in
// native/crates/aimux/tests/transient_state_surfaces.rs.
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "testdata",
  "contracts",
  "v1",
  "transient-state-presentation",
  "surfaces.json",
);

interface PresentationCase {
  why: string;
  action: string;
  family: "progress" | "attention" | "failure";
  label: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const cases: PresentationCase[] = fixture.cases;
const attentionStates: string[] = fixture.attentionStates.states;

// The app's spelling of each family. `working` is cyan, `needs` amber, `error`
// rose; the TUI's are Work, Attention and Danger.
const APP_FAMILY = { progress: "working", attention: "needs", failure: "error" } as const;

describe("a transient state renders the same way on every surface", () => {
  it("covers the whole published vocabulary", () => {
    expect([...TRANSIENT_ACTIONS].sort()).toEqual(cases.map((entry) => entry.action).sort());
  });

  it.each(cases)("$action reads as $label ($why)", ({ action, label }) => {
    expect(pendingActionLabel(action)).toBe(label);
  });

  it("answers every action the same way", () => {
    expect(pendingActionStatusKind()).toBe(APP_FAMILY.progress);
  });

  it.each(cases)("$action is $family ($why)", ({ action, family }) => {
    // Through the two production callers, which take a whole session: an early
    // return that bypasses the shared rule is exactly how this surface drifted
    // in the first place.
    //
    // The agent session carries a `pendingAction` and NO `semantic`, which is
    // what `stores/lifecycleTransitions.ts` really pushes for an action it
    // started. An earlier revision of this test handed it a `user.label` of
    // `ready` for all fourteen actions, which is only true for the eight the
    // service does not name -- `creating` and `forking` really come back as
    // `starting`, `graveyarding` as `graveyarding` -- so it was asserting a
    // payload the overlay never sends alongside one it sometimes does.
    expect(
      deriveAgentState({
        id: "claude-1",
        status: "running",
        pendingAction: action,
      } as DesktopSession).kind,
    ).toBe(APP_FAMILY[family]);
    expect(serviceStatusKind({ pendingAction: action, status: "offline" })).toBe(
      APP_FAMILY[family],
    );
  });

  // And the word, which is the half the row lost when it started reading
  // `statusLabel`: an optimistic session has no `statusLabel` for the action,
  // so taking the word from the payload rendered "Unknown" while an agent was
  // being created.
  it.each(cases)("$action is still worded $label ($why)", ({ action, label }) => {
    expect(
      deriveAgentState({
        id: "claude-1",
        status: "running",
        pendingAction: action,
      } as DesktopSession).label,
    ).toBe(label);
  });

  // Pinned beside the others so that making progress quieter cannot quietly
  // make these quieter too.
  it.each(attentionStates)("%s still asks for the person", (state) => {
    expect(
      deriveAgentState({
        id: "claude-1",
        status: "running",
        semantic: { user: { label: state }, presentation: { statusLabel: state } },
      } as DesktopSession).kind,
    ).toBe(APP_FAMILY.attention);
  });

  // A blank action is not an action. It used to short-circuit the attention a
  // running agent was asking for.
  it("does not let a blank action borrow the progress tone", () => {
    expect(
      deriveAgentState({
        id: "claude-1",
        status: "running",
        pendingAction: "  ",
        semantic: {
          user: { label: "needs_input" },
          presentation: { statusLabel: "needs input" },
        },
      } as DesktopSession).kind,
    ).toBe(APP_FAMILY.attention);
  });
});
