import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CHAT_HISTORY_FLOOR_LINES } from "./chat-history-floor";

/**
 * AGENTS.md "One Answer, Many Surfaces". The depth this view pages to is a
 * number the service also holds, and the sentence on screen quotes it. Two
 * copies drift silently: raise the service's cap and the app keeps paging to
 * 2000 while claiming the new number, or raise the app's floor and it asks for
 * lines the service refuses.
 */
describe("the history depth, across the app and the service", () => {
  it("matches MAX_AGENT_OUTPUT_CAPTURE_LINES in the project service", () => {
    const source = readFileSync(
      join(__dirname, "../../native/crates/aimux/src/project_service/agent_output.rs"),
      "utf8",
    );
    const match = /pub const MAX_AGENT_OUTPUT_CAPTURE_LINES: i64 = ([\d_]+);/.exec(source);
    expect(match, "the service's cap moved or was renamed").not.toBeNull();
    const serviceLimit = Number(match?.[1].replaceAll("_", ""));
    // Not equality: the view may deliberately page less deep than the service
    // will serve. Asking for more than it serves is the drift that breaks.
    expect(CHAT_HISTORY_FLOOR_LINES).toBeLessThanOrEqual(serviceLimit);
  });
});
