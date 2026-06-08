import { describe, expect, it } from "vitest";

import { parseEnvAssignments, parseShellArgs } from "./shell-args.js";

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

describe("parseEnvAssignments", () => {
  it("parses space-separated NAME=VALUE tokens", () => {
    expect(parseEnvAssignments("CLAUDE_YOLO=1 FOO=bar")).toEqual({ CLAUDE_YOLO: "1", FOO: "bar" });
  });

  it("returns an empty object for blank input", () => {
    expect(parseEnvAssignments("   ")).toEqual({});
  });

  it("supports quoted values with spaces", () => {
    expect(parseEnvAssignments('MSG="hello world"')).toEqual({ MSG: "hello world" });
  });

  it("throws on a token that is not an assignment", () => {
    expect(() => parseEnvAssignments("FOO=bar --flag")).toThrow('invalid env var "--flag"');
  });
});
