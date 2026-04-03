import { describe, expect, it } from "vitest";
import { OscNotificationParser } from "./osc-notifications.js";

describe("OscNotificationParser", () => {
  it("parses OSC 777 notifications and strips them from output", () => {
    const parser = new OscNotificationParser();
    const result = parser.parseChunk(`before \u001b]777;notify;Title;Body\u0007 after`);

    expect(result.cleaned).toBe("before  after");
    expect(result.notifications).toEqual([{ source: "osc777", title: "Title", body: "Body" }]);
  });

  it("parses OSC 9 iTerm-style notifications", () => {
    const parser = new OscNotificationParser();
    const result = parser.parseChunk(`\u001b]9;Hello world\u0007`);

    expect(result.cleaned).toBe("");
    expect(result.notifications).toEqual([{ source: "osc9", title: "", body: "Hello world" }]);
  });

  it("ignores ConEmu OSC 9 subcommands", () => {
    const parser = new OscNotificationParser();
    const result = parser.parseChunk(`\u001b]9;12\u0007prompt`);

    expect(result.cleaned).toBe("prompt");
    expect(result.notifications).toEqual([]);
  });

  it("parses OSC 99 Kitty title and body chunks", () => {
    const parser = new OscNotificationParser();
    const first = parser.parseChunk(`\u001b]99;i=abc:d=0:p=title;Kitty Title\u0007`);
    const second = parser.parseChunk(`\u001b]99;i=abc:p=body;Kitty Body\u0007`);

    expect(first.notifications).toEqual([]);
    expect(second.notifications).toEqual([{ source: "osc99", title: "Kitty Title", body: "Kitty Body" }]);
  });

  it("buffers incomplete OSC sequences across chunks", () => {
    const parser = new OscNotificationParser();
    const first = parser.parseChunk("hello \u001b]777;notify;Ti");
    const second = parser.parseChunk("tle;Body\u0007 world");

    expect(first.cleaned).toBe("hello ");
    expect(first.notifications).toEqual([]);
    expect(second.cleaned).toBe(" world");
    expect(second.notifications).toEqual([{ source: "osc777", title: "Title", body: "Body" }]);
  });
});
