import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { looksLikeAgentCommand } from "@/lib/agent-command";

/**
 * One file decides what a command is, and both languages read THAT file.
 *
 * The daemon asks the question to choose whether a shared-chat message keeps
 * its `[sender]` attribution; the app asks it to choose whether to expect the
 * message back in the parsed transcript. Same rule, two uses -- and while each
 * side owned its own answer, a command the app read as prose produced "Send
 * not confirmed yet" for a message that was delivered perfectly.
 *
 * The rule itself is asserted against the contract on both sides:
 * `agent-command.test.ts` here, and
 * `the_command_rule_matches_the_contract_both_sides_read` in
 * `native/crates/aimux/src/project_service/agent_input.rs`. What this file
 * holds is the thing neither of those can see -- that the two tests are
 * reading the same bytes. A forked fixture would leave both suites green
 * while the surfaces disagreed again.
 *
 * What the app then DOES with the answer is proved by running the screen's
 * real send, in `composer-send-lifecycle.test.ts`.
 */
const CONTRACT = "testdata/contracts/v1/agent-command-input.json";
const REPO = join(__dirname, "..", "..");
const RUST = join(REPO, "native/crates/aimux/src/project_service/agent_input.rs");
const APP_TEST = join(REPO, "app/lib/agent-command.test.ts");

describe("the command rule has one source of truth", () => {
  it("is read from the same path by the daemon and the app", () => {
    const rust = readFileSync(RUST, "utf8");
    const appTest = readFileSync(APP_TEST, "utf8");
    // The Rust side resolves it from CARGO_MANIFEST_DIR, the app side from
    // its own directory; both have to land on this file.
    expect(rust).toContain(`/../../../${CONTRACT}`);
    expect(appTest).toContain(`../../${CONTRACT}`);
    expect(readFileSync(join(REPO, CONTRACT), "utf8").length).toBeGreaterThan(0);
  });

  it("answers both ways, so a fixture that lost a list would be noticed", () => {
    const contract = JSON.parse(readFileSync(join(REPO, CONTRACT), "utf8")) as {
      commands: string[];
      prose: string[];
    };
    expect(contract.commands.length).toBeGreaterThan(4);
    expect(contract.prose.length).toBeGreaterThan(4);
    expect(looksLikeAgentCommand(contract.commands[0]!)).toBe(true);
    expect(looksLikeAgentCommand(contract.prose[0]!)).toBe(false);
  });
});
