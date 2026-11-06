import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import commandContract from "../../testdata/contracts/v1/agent-command-input.json";
import { looksLikeAgentCommand } from "@/lib/agent-command";

/**
 * A command gets no echo expectation, at the call site and not only in theory.
 *
 * Confirmation is echo-based: a send is confirmed by its text appearing in the
 * PARSED transcript. A command is consumed by the agent and need not come back
 * as a user turn at all, so queueing an echo for one guaranteed a "Send not
 * confirmed yet" ten seconds later for a command that ran perfectly. `/queue`
 * over the shared chat is how this was found.
 *
 * The helper is covered by `agent-command.test.ts` against the same contract
 * the daemon asserts. What this file holds is the wiring: the composer has to
 * ASK. That is the half a helper test cannot see, and the half that goes
 * missing when someone refactors the send path.
 */
const SCREEN = join(__dirname, "..", "components", "screens", "AgentChatScreen.tsx");

describe("the composer does not wait for an echo of a command", () => {
  const source = readFileSync(SCREEN, "utf8");

  it("guards the echo registration with the shared command rule", () => {
    expect(source).toContain('import { looksLikeAgentCommand } from "@/lib/agent-command"');
    // The guard sits immediately before the only place an echo is queued.
    const guard = source.indexOf("if (!looksLikeAgentCommand(text))");
    const register = source.indexOf("setAcceptedComposerMessages((current) =>");
    expect(guard, "the echo registration is guarded").toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(guard);
    expect(register - guard).toBeLessThan(600);
  });

  it("queues an echo for exactly one of these two sends", () => {
    // The behaviour the guard exists for, stated as the contract states it:
    // prose is confirmed by its echo, a command is confirmed by acceptance.
    expect(looksLikeAgentCommand("/queue")).toBe(true);
    expect(looksLikeAgentCommand("queue up the next task")).toBe(false);
  });

  it("uses the same cases the daemon does", () => {
    // Not a second opinion about what a command is: one file, both sides.
    for (const command of commandContract.commands) {
      expect(looksLikeAgentCommand(command), `${JSON.stringify(command)}`).toBe(true);
    }
  });
});
