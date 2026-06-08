import { describe, expect, it } from "vitest";

import { parseEnvAssignments, parseLaunchCommandLine, parseShellArgs } from "./shell-args.js";

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

describe("parseLaunchCommandLine", () => {
  it("parses a plain command with args", () => {
    expect(parseLaunchCommandLine("claude --resume")).toEqual({
      command: "claude",
      args: ["--resume"],
      env: undefined,
    });
  });

  it("routes leading NAME=VALUE tokens into env", () => {
    expect(parseLaunchCommandLine("CLAUDE_YOLO=1 FOO=bar claude --resume")).toEqual({
      command: "claude",
      args: ["--resume"],
      env: { CLAUDE_YOLO: "1", FOO: "bar" },
    });
  });

  it("stops collecting env at the first non-assignment token", () => {
    const result = parseLaunchCommandLine("A=1 claude B=2 --flag");
    expect(result.command).toBe("claude");
    expect(result.args).toEqual(["B=2", "--flag"]);
    expect(result.env).toEqual({ A: "1" });
  });

  it("supports quoted env values", () => {
    expect(parseLaunchCommandLine("MSG=\"hello world\" claude")).toEqual({
      command: "claude",
      args: [],
      env: { MSG: "hello world" },
    });
  });

  it("throws when only env assignments are given", () => {
    expect(() => parseLaunchCommandLine("FOO=bar")).toThrow("no command to launch");
  });

  it("throws on empty input", () => {
    expect(() => parseLaunchCommandLine("   ")).toThrow("no command to launch");
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
