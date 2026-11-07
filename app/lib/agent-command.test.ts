import { describe, expect, it } from "vitest";
import contract from "../../testdata/contracts/v1/agent-command-input.json";
import { looksLikeAgentCommand } from "@/lib/agent-command";

// The daemon asserts this same file. When each side owned its own answer, a
// command the app read as prose produced "Send not confirmed yet" for a
// message that was delivered perfectly -- the app waited for a transcript
// echo the agent was never going to write.
describe("what counts as a command to the agent", () => {
  it("agrees with the contract on every command", () => {
    for (const command of contract.commands) {
      expect(looksLikeAgentCommand(command), `${JSON.stringify(command)} is a command`).toBe(true);
    }
  });

  it("agrees with the contract on every piece of prose", () => {
    for (const prose of contract.prose) {
      expect(looksLikeAgentCommand(prose), `${JSON.stringify(prose)} is prose`).toBe(false);
    }
  });

  it("covers both answers, so neither list can quietly empty", () => {
    expect(contract.commands.length).toBeGreaterThan(4);
    expect(contract.prose.length).toBeGreaterThan(4);
  });
});
