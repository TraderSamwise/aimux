import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { deriveAgentState } from "@/lib/agent-status-label";
import type { DesktopSession, DesktopSessionStatus } from "@/lib/desktop-state";

// The app half of the cross-surface agent-status-label check. AGENTS.md "One
// Answer, Many Surfaces": a per-surface test passes happily while the surfaces
// disagree, and these two did. This row computed its own word from `status` and
// said "Running" for an agent the project service had already called `ready` --
// an agent that had finished its turn and was sitting at an empty prompt. The
// status dot beside that word was right the whole time.
//
// The service reads this same file in
// native/crates/aimux/tests/agent_status_label_surfaces.rs, where it asserts the
// `userLabel` and `statusLabel` columns are what `derive_session_semantics`
// actually produces. So the words below are not this test's opinion: they are
// pinned at the source, and this half only asserts the row renders them.
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "testdata",
  "contracts",
  "v1",
  "agent-status-label",
  "surfaces.json",
);

interface LabelCase {
  why: string;
  status: DesktopSessionStatus;
  activity: string | null;
  attention: string;
  pendingAction?: string;
  hasActiveTask?: boolean;
  userLabel: string;
  statusLabel: string;
  appLabel: string;
  appKind: string;
  appPill: boolean;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const cases: LabelCase[] = fixture.cases;

function sessionFor(entry: {
  status: DesktopSessionStatus;
  activity?: string | null;
  attention?: string;
  pendingAction?: string;
  userLabel?: string;
  statusLabel: string;
}): DesktopSession {
  return {
    id: "claude-1",
    status: entry.status,
    activity: entry.activity ?? undefined,
    attention: entry.attention,
    pendingAction: entry.pendingAction,
    semantic: {
      user: { label: entry.userLabel ?? null },
      presentation: { statusLabel: entry.statusLabel },
    },
  } as DesktopSession;
}

describe("an agent's state is worded the same on every surface", () => {
  it.each(cases)("$statusLabel reads as $appLabel ($why)", (entry) => {
    expect(deriveAgentState(sessionFor(entry)).label).toBe(entry.appLabel);
  });

  // The tone, pinned beside the word in the same case rather than in a test of
  // its own. The first pass at this fix moved the word and left two states where
  // the two disagreed -- "Working" beside an amber needs-the-user dot for an
  // agent the daemon was starting, and an idle dot beside "Next step".
  it.each(cases)("$statusLabel is toned $appKind ($why)", (entry) => {
    expect(deriveAgentState(sessionFor(entry)).kind).toBe(entry.appKind);
  });

  it.each(cases)("$statusLabel is $appPill as a pill ($why)", (entry) => {
    expect(deriveAgentState(sessionFor(entry)).pill).toBe(entry.appPill);
  });

  // The case the item was filed for, on its own so a regression names itself
  // rather than arriving as one row of a loop.
  it("never says Running for an agent sitting at its prompt", () => {
    const state = deriveAgentState(
      sessionFor({
        status: "running",
        activity: "idle",
        attention: "normal",
        statusLabel: "ready",
      }),
    );
    expect(state.label).toBe("Ready");
    expect(state.label).not.toBe("Running");
    expect(state.pill).toBe(false);
  });

  // A broken payload has to be visible. The service attaches `semantic` to
  // every session unconditionally, so an absent word is not a state -- and a
  // blank cell would read as one.
  it("says so rather than guessing when the service sent no word", () => {
    const session = { id: "claude-1", status: "running" } as DesktopSession;
    expect(deriveAgentState(session).label).toBe("Unknown");
  });

  // The precedence that used to live in this file now lives in the service, so
  // what is checked here is that the row defers to it: an attention state the
  // old chain would have ranked itself is rendered from the served answer, word
  // and tone both.
  it("defers to the served answer even when the raw fields would rank differently", () => {
    const state = deriveAgentState(
      sessionFor({
        status: "running",
        activity: "running",
        attention: "needs_input",
        // The service decided this is work, whatever the raw attention says.
        userLabel: "working",
        statusLabel: "working",
      }),
    );
    expect(state.label).toBe("Working");
    expect(state.kind).toBe("working");
  });

  // The two states the old raw-field ranking could not see, named so a
  // regression reports which one rather than one row of a loop.
  it("tones a starting agent as work, not as an ask", () => {
    const state = deriveAgentState(
      sessionFor({ status: "waiting", userLabel: "working", statusLabel: "working" }),
    );
    expect(state.label).toBe("Working");
    expect(state.kind).toBe("working");
  });

  it("tones an idle agent with a task still assigned as an ask", () => {
    const state = deriveAgentState(
      sessionFor({
        status: "running",
        activity: "idle",
        userLabel: "next_step",
        statusLabel: "next step",
      }),
    );
    expect(state.label).toBe("Next step");
    expect(state.kind).toBe("needs");
  });
});
