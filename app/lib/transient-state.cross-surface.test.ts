import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  TRANSIENT_ACTIONS,
  agentStatusKind,
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
    // Through the two callers, which take a whole session: an early return that bypasses
    // the shared rule is exactly how this surface drifted in the first place.
    expect(agentStatusKind({ pendingAction: action, status: "waiting" })).toBe(APP_FAMILY[family]);
    expect(serviceStatusKind({ pendingAction: action, status: "offline" })).toBe(
      APP_FAMILY[family],
    );
  });

  // Pinned beside the others so that making progress quieter cannot quietly
  // make these quieter too.
  it.each(attentionStates)("%s still asks for the person", (state) => {
    expect(agentStatusKind({ status: "running", attention: state })).toBe(APP_FAMILY.attention);
  });
});
