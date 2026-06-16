import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getGlobalConfigPath } from "../paths.js";

import {
  buildToolOptionsOverlayOutput,
  buildToolPickerOverlayOutput,
  defaultsLaunchOverride,
  formatEnvDefaults,
} from "./tool-picker.js";
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
  function stripAnsi(s: string): string {
    return s
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\x1b\[\d+;\d+H/g, "")
      .replace(/\x1b[78]/g, "");
  }

  it("renders a centered title-band modal with the launch fields", async () => {
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

    const out = buildToolOptionsOverlayOutput(host, 80, 24);
    const plain = stripAnsi(out);
    // Title-band chrome: rounded top, band title, separator.
    expect(plain).toContain("╭");
    expect(plain).toContain("├");
    expect(plain).toContain("CLAUDE: LAUNCH OPTIONS");
    expect(plain).toContain("Extra args:");
    expect(plain).toContain("Env vars:");
  });

  it("explains the empty state when no tools are enabled", async () => {
    await initPaths(mkdtempSync(join(tmpdir(), "aimux-toolpicker-")));
    // The global config path is shared across this file's tests, so restore it.
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({ tools: { claude: { enabled: false }, codex: { enabled: false }, aider: { enabled: false } } }),
    );
    try {
      const out = buildToolPickerOverlayOutput({ pickerMode: "create" }, 80, 24);
      const plain = stripAnsi(out);
      expect(plain).toContain("SELECT TOOL");
      expect(plain).toContain("No enabled tools");
    } finally {
      rmSync(getGlobalConfigPath(), { force: true });
    }
  });

  it("switches to the danger variant when a field fails to parse", async () => {
    await initPaths(mkdtempSync(join(tmpdir(), "aimux-toolpicker-")));
    const host = {
      pickerMode: "launch",
      launchOptionsState: {
        toolKey: "claude",
        args: createLineState("'unterminated"),
        env: createLineState(""),
        activeField: "args" as const,
        error: null,
      },
    };

    const out = buildToolOptionsOverlayOutput(host, 80, 24);
    expect(out).toContain("\x1b[31m");
    expect(stripAnsi(out)).toContain("Error:");
  });
});
