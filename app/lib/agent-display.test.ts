import { describe, expect, it } from "vitest";

import {
  agentCompactIdentity,
  agentRoleLabel,
  agentShortName,
  agentToolName,
  isGeneratedAgentLabel,
} from "./agent-display";

describe("agent display labels", () => {
  it("collapses generated session labels to the tool name", () => {
    const agent = {
      id: "codex-o6o4kf",
      label: "codex-o6o4kf",
      command: "codex --model gpt-5.5",
      role: "coder",
    };

    expect(agentToolName(agent)).toBe("codex");
    expect(isGeneratedAgentLabel(agent.label, agent)).toBe(true);
    expect(agentShortName(agent)).toBe("codex");
    expect(agentCompactIdentity(agent)).toBe("codex (coder)");
  });

  it("keeps custom labels because they carry user intent", () => {
    const agent = {
      id: "claude-k9czzb",
      label: "overseer",
      command: "claude",
      role: "reviewer",
    };

    expect(isGeneratedAgentLabel(agent.label, agent)).toBe(false);
    expect(agentShortName(agent)).toBe("overseer");
    expect(agentCompactIdentity(agent)).toBe("overseer (reviewer)");
  });

  it("does not collapse custom labels that happen to start with a tool prefix", () => {
    expect(
      agentShortName({
        id: "codex-o6o4kf",
        label: "codex-reviewer",
        command: "codex --model gpt-5.5",
      }),
    ).toBe("codex-reviewer");
    expect(
      agentShortName({
        id: "claude-k9czzb",
        label: "claude-overseer",
        command: "claude",
      }),
    ).toBe("claude-overseer");
  });

  it("uses command and id fallbacks when a label is missing", () => {
    expect(agentShortName({ id: "claude-k9czzb", command: "claude" })).toBe("claude");
    expect(agentShortName({ id: "aider-abc123" })).toBe("aider");
    expect(agentRoleLabel({ role: " coder " })).toBe("coder");
  });
});
