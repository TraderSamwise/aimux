import { describe, expect, it } from "vitest";

import { activityTextFromParsedAgentOutput, parseAgentOutput } from "./agent-output-parser.js";

const verbFor = (pane: string, tool: string) => activityTextFromParsedAgentOutput(parseAgentOutput(pane, { tool }));

describe("the tool's own progress line", () => {
  it("reads Claude's verb with its elapsed time and tokens", () => {
    expect(verbFor("✻ Jitterbugging… (2m 23s · ↓ 8.1k tokens)", "claude")).toBe(
      "Jitterbugging… (2m 23s · ↓ 8.1k tokens)",
    );
  });

  it("reads every spinner frame, not just the three it used to", () => {
    // The frame rotates while the verb stays put. Matching a subset meant the
    // same line was status or response depending on which frame was on screen.
    for (const frame of ["✢", "✳", "✶", "✻", "✽", "·"]) {
      expect(verbFor(`${frame} Transfiguring… (14s)`, "claude")).toBe("Transfiguring… (14s)");
    }
  });

  it("reads codex's line through the same path", () => {
    expect(verbFor("• Working (4s • esc to interrupt)", "codex")).toBe("Working (4s • esc to interrupt)");
    expect(verbFor("* Indexing… (running stop hook · 11s · ↓ 16 tokens)", "codex")).toBe(
      "Indexing… (running stop hook · 11s · ↓ 16 tokens)",
    );
  });

  it("refuses a finished turn", () => {
    // `Worked for 20m 16s` fits the same progress shape but reports a turn that
    // ended. Showing it live would park a frozen timer beside an idle agent.
    expect(verbFor("- Worked for 20m 16s", "codex")).toBe("");
    expect(verbFor("✻ Cogitated for 35s · 3 shells still running", "claude")).toBe("");
  });

  it("takes the newest line when the pane holds several", () => {
    const pane = ["✻ Booting… (1s)", "⏺ Did a thing.", "✻ Jitterbugging… (2m 23s)"].join("\n");
    expect(verbFor(pane, "claude")).toBe("Jitterbugging… (2m 23s)");
  });

  it("does not hand back the footer that shares its status block", () => {
    // Status blocks get merged, so the newest verb usually sits in a block that
    // also absorbed the shell footer. Taking the block's text would return that.
    const pane = ["✻ Jitterbugging… (2m 23s)", "sam@MacBook-Pro-4 ~/cs/aimux  42% (1M context)"].join("\n");
    const verb = verbFor(pane, "claude");
    expect(verb).toBe("Jitterbugging… (2m 23s)");
    expect(verb).not.toContain("MacBook");
  });

  it("is empty for a pane that is not reporting progress", () => {
    expect(verbFor("⏺ Here is the answer.", "claude")).toBe("");
    expect(verbFor("", "claude")).toBe("");
  });
});
