import { describe, expect, it } from "vitest";

import { defaultsLaunchOverride, formatEnvDefaults } from "./tool-picker.js";
import type { ToolConfig } from "../config.js";

function tool(partial: Partial<ToolConfig>): ToolConfig {
  return { command: "claude", args: ["--base"], enabled: true, ...partial };
}

describe("formatEnvDefaults", () => {
  it("returns empty string for undefined env", () => {
    expect(formatEnvDefaults(undefined)).toBe("");
  });

  it("renders KEY=VALUE pairs and quotes values with spaces", () => {
    expect(formatEnvDefaults({ A: "1", MSG: "hello world" })).toBe("A=1 MSG='hello world'");
  });
});

describe("defaultsLaunchOverride", () => {
  it("returns undefined when the tool has no configured defaults", () => {
    expect(defaultsLaunchOverride(tool({}))).toBeUndefined();
    expect(defaultsLaunchOverride(tool({ defaultArgs: [], defaultEnv: {} }))).toBeUndefined();
  });

  it("appends defaultArgs after the base args, keeping the tool command", () => {
    expect(defaultsLaunchOverride(tool({ defaultArgs: ["--model", "opus"] }))).toEqual({
      command: "claude",
      args: ["--base", "--model", "opus"],
      env: undefined,
    });
  });

  it("carries defaultEnv through", () => {
    expect(defaultsLaunchOverride(tool({ defaultEnv: { CLAUDE_YOLO: "1" } }))).toEqual({
      command: "claude",
      args: ["--base"],
      env: { CLAUDE_YOLO: "1" },
    });
  });

  it("combines default args and env", () => {
    expect(
      defaultsLaunchOverride(tool({ defaultArgs: ["--model", "opus"], defaultEnv: { FOO: "bar" } })),
    ).toEqual({
      command: "claude",
      args: ["--base", "--model", "opus"],
      env: { FOO: "bar" },
    });
  });
});
