import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAgentPrompt, stripTerminalEscapes } from "./agent-prompt";

const FIXTURES = join(__dirname, "__fixtures__", "agent-prompts");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const TRUST = fixture("01-workspace-trust.ansi");
const PERMISSION = fixture("02-tool-permission-numbered.ansi");
const PROSE = fixture("03-prose-question-no-menu.ansi");
const ASK_QUESTION = fixture("04-askuserquestion-options.ansi");
const PLAN = fixture("05-plan-approval.ansi");

describe("reading a prompt out of a real pane", () => {
  it("reads the numbered tool permission", () => {
    const prompt = parseAgentPrompt(PERMISSION);
    expect(prompt?.question).toBe("Do you want to create hello.txt?");
    expect(prompt?.options.map((option) => option.number)).toEqual([1, 2, 3]);
    expect(prompt?.options[0]).toMatchObject({ label: "Yes", selected: true });
    expect(prompt?.options[2]).toMatchObject({ label: "No", selected: false });
  });

  it("reads the unnumbered workspace trust prompt", () => {
    // No digits anywhere in this one, so a numbers-only parser sees nothing.
    const prompt = parseAgentPrompt(TRUST);
    expect(prompt?.options.map((option) => option.label)).toEqual([
      "No, exit",
      "Yes, I trust this folder",
    ]);
    expect(prompt?.options[0]?.selected).toBe(true);
    expect(prompt?.options.every((option) => option.number === null)).toBe(true);
  });

  it("keeps the option that sits BELOW the box border", () => {
    // AskUserQuestion draws "Chat about this" under the bottom edge. A
    // collector that stopped at the border dropped a real choice.
    const prompt = parseAgentPrompt(ASK_QUESTION);
    expect(prompt?.question).toBe("Which colour do you prefer?");
    expect(prompt?.options.map((option) => option.number)).toEqual([1, 2, 3, 4, 5]);
    expect(prompt?.options.at(-1)?.label).toBe("Chat about this");
  });

  it("reads the plan approval, which has no Esc-to-cancel footer", () => {
    // Keying detection on the footer would miss this one entirely.
    const prompt = parseAgentPrompt(PLAN);
    expect(prompt?.options.map((option) => option.number)).toEqual([1, 2, 3]);
    expect(prompt?.options[0]?.selected).toBe(true);
    expect(prompt?.question).toContain("Would you like to proceed?");
  });

  it("does NOT see a prompt in a prose question", () => {
    // The whole negative case. This pane asks something in words and waits at
    // an empty composer; rendering a chooser over it would be worse than not
    // having the feature.
    expect(parseAgentPrompt(PROSE)).toBeNull();
  });

  it("ignores options left in scrollback above an idle composer", () => {
    // Composed from two real captures rather than invented: the permission
    // prompt's options, followed by the prose fixture's idle composer. That
    // is what a pane looks like when a prompt has been answered and the
    // agent is waiting for words again.
    //
    // Without the empty-composer guard the stale options parse as a live
    // chooser, and the GUI offers buttons that answer nothing.
    const answered = `${PERMISSION}\n${PROSE}`;
    expect(parseAgentPrompt(answered)).toBeNull();
  });

  it("is not fooled by how many cursors a pane holds", () => {
    // Measured: the prose fixture carries THREE cursor marks and the trust
    // prompt carries one, because the cursor is also the composer and every
    // echoed past message. Counting them gets the answer exactly backwards.
    const cursors = (text: string) => (stripTerminalEscapes(text).match(/❯/g) ?? []).length;
    expect(cursors(PROSE)).toBeGreaterThan(cursors(TRUST));
    expect(parseAgentPrompt(PROSE)).toBeNull();
    expect(parseAgentPrompt(TRUST)).not.toBeNull();
  });
});

describe("escape handling", () => {
  it("strips an OSC-8 hyperlink envelope, not just colour", () => {
    // `ansi.ts` handles SGR only, which is right for rendering but leaves the
    // link envelope in the text. The trust prompt contains one.
    const text = stripTerminalEscapes(TRUST);
    expect(text).toContain("Security guide");
    expect(text).not.toContain("]8;");
    expect(text).not.toContain("https://code.claude.com");
  });

  it("leaves ordinary text alone", () => {
    expect(stripTerminalEscapes("plain words")).toBe("plain words");
  });
});
