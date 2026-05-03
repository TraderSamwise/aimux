import { describe, expect, it } from "vitest";

import { parseShellArgs } from "./shell-args.js";

describe("parseShellArgs", () => {
  it("splits whitespace separated args", () => {
    expect(parseShellArgs("--model gpt-5.5 --danger")).toEqual(["--model", "gpt-5.5", "--danger"]);
  });

  it("preserves quoted groups", () => {
    expect(parseShellArgs("--message \"hello world\" --name 'sam test'")).toEqual([
      "--message",
      "hello world",
      "--name",
      "sam test",
    ]);
  });

  it("supports backslash escapes outside single quotes", () => {
    expect(parseShellArgs("--name hello\\ world --literal 'a\\b'")).toEqual([
      "--name",
      "hello world",
      "--literal",
      "a\\b",
    ]);
  });

  it("preserves empty quoted args", () => {
    expect(parseShellArgs('--empty "" --next')).toEqual(["--empty", "", "--next"]);
  });

  it("rejects unterminated quotes", () => {
    expect(() => parseShellArgs('--message "hello')).toThrow("unterminated double quote");
  });
});
