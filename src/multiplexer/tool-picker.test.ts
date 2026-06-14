import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildToolOptionsOverlayOutput, defaultsLaunchOverride, formatEnvDefaults } from "./tool-picker.js";
import { createLineState } from "../line-editor.js";
import { initPaths } from "../paths.js";
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
    expect(defaultsLaunchOverride(tool({ defaultArgs: ["--model", "opus"], defaultEnv: { FOO: "bar" } }))).toEqual({
      command: "claude",
      args: ["--base", "--model", "opus"],
      env: { FOO: "bar" },
    });
  });
});

describe("buildToolOptionsOverlayOutput", () => {
  it("re-asserts the box color after the active field so padding keeps the modal background", async () => {
    await initPaths(mkdtempSync(join(tmpdir(), "aimux-toolpicker-")));
    const host = {
      pickerMode: "launch",
      launchOptionsState: {
        toolKey: "claude",
        args: createLineState(""),
        env: createLineState(""),
        activeField: "args" as const,
        error: null,
      },
    };

    const out = buildToolOptionsOverlayOutput(host);
    const row = out.split(/(?=\x1b\[\d+;\d+H)/).find((r) => r.includes("Extra args"));
    expect(row).toBeDefined();
    // The reverse-video cursor makes truncateAnsi append \x1b[0m; the box must
    // re-assert its color before the trailing padding, otherwise the padding
    // renders with the terminal's default background instead of the modal's.
    expect(row).toMatch(/\x1b\[0m\x1b\[44;97m {2,}\x1b\[0m$/);
  });
});
