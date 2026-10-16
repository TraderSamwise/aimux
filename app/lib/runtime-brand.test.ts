import { describe, expect, it } from "vitest";

import { runtimeBrandForAgent, runtimeBrandForTool } from "@/lib/runtime-brand";

describe("runtime brand", () => {
  // Every tool name the product can hand over, including the fallback
  // `agentToolName` itself returns, so a new tool has to be given a brand
  // rather than inheriting one.
  const BRAND_IDS = {
    claude: "claude",
    codex: "codex",
    aider: "aider",
    shell: "shell",
    service: "service",
    // `agentToolName`'s own fallback, and anything nobody has taught this map.
    agent: "unknown",
    gemini: "unknown",
    "": "unknown",
  } as const;

  it("names only the runtimes it has been taught", () => {
    for (const [tool, expected] of Object.entries(BRAND_IDS)) {
      expect(runtimeBrandForTool(tool).id, tool).toBe(expected);
    }
    expect(runtimeBrandForTool(null).id).toBe("unknown");
    expect(runtimeBrandForTool(undefined).id).toBe("unknown");
  });

  // Guessing is the failure that matters: the wrong name on someone's chat.
  it("does not guess a known runtime from an unknown one", () => {
    for (const tool of ["gemini", "cursor", "claude-code-like", "agent"]) {
      expect(runtimeBrandForTool(tool).label, tool).toBe("Agent");
    }
  });

  // `in` walks the prototype; these are the names that exposes.
  it("does not mistake an object's own members for runtimes", () => {
    for (const tool of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const brand = runtimeBrandForTool(tool);
      expect(brand.id, tool).toBe("unknown");
      expect(brand.shortLabel, tool).toBe("AG");
    }
  });

  it("carries a real word as well as the two letters", () => {
    expect(runtimeBrandForTool("claude").label).toBe("Claude");
    expect(runtimeBrandForTool("claude").shortLabel).toBe("CL");
    expect(runtimeBrandForTool("codex").label).toBe("Codex");
    expect(runtimeBrandForTool("codex").shortLabel).toBe("CX");
    for (const tool of Object.keys(BRAND_IDS)) {
      expect(runtimeBrandForTool(tool).shortLabel, tool).toHaveLength(2);
    }
  });

  // The one place the tool name and the brand differ: `agentToolName` answers
  // with the command's first token, so a shell agent says `zsh`.
  it("reads every shell as the shell runtime", () => {
    for (const shell of ["zsh", "bash", "sh", "fish"]) {
      expect(runtimeBrandForTool(shell).id, shell).toBe("shell");
      expect(runtimeBrandForTool(shell).label, shell).toBe("Shell");
    }
  });

  it("is case insensitive, because the key is stored however it was written", () => {
    expect(runtimeBrandForTool("Claude").id).toBe("claude");
    expect(runtimeBrandForTool("  CODEX  ").id).toBe("codex");
  });

  // The tool itself is `agentToolName`'s answer, not a second opinion: the
  // config key wins, then the command's first token, then a generated label.
  // Sniffing the command here would be the second opinion.
  it("takes the tool from the one helper that decides it", () => {
    expect(runtimeBrandForAgent({ toolConfigKey: "codex" }).id).toBe("codex");
    expect(runtimeBrandForAgent({ command: "claude --continue" }).id).toBe("claude");
    expect(runtimeBrandForAgent({ command: "zsh -l" }).id).toBe("shell");
    expect(runtimeBrandForAgent({ label: "aider-7x2k9" }).id).toBe("aider");
    expect(runtimeBrandForAgent({ toolConfigKey: "codex", command: "claude" }).id).toBe("codex");
    expect(runtimeBrandForAgent({}).id).toBe("unknown");
  });
});
