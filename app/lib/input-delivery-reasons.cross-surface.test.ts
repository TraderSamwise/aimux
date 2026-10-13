import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatLivePaneInputDeliveryNotice } from "@/lib/input-delivery";

/**
 * Every reason the project service HOLDS on has words for the user.
 *
 * The formatter cased on `visible-unsubmitted-input` and `max-hold-elapsed`.
 * The service emits neither. So the one branch that told the user what to do
 * was dead and the notice rendered the enum:
 *
 *   Input held, not delivered yet: visible-unsubmitted-input-recent-user-input
 *
 * Two surfaces naming one fact, drifting silently, with nothing comparing
 * them. This reads the reasons out of the Rust source instead of listing
 * them, so a new hold reason fails here until it has wording.
 */

const DELIVERY_SOURCE = join(
  import.meta.dirname,
  "..",
  "..",
  "native",
  "crates",
  "aimux",
  "src",
  "project_service",
  "agent_input_delivery.rs",
);

/** The generic text, which means "we had no wording for this reason". */
const FALLBACK = "Aimux will retry shortly; the agent terminal was busy.";

/**
 * The `reason: "..."` literals inside `Hold` arms.
 *
 * `DeliverNow` reasons never reach the formatter -- the response comes back
 * `state: "delivered"` and the notice is null -- so only the held ones need
 * words.
 */
function heldReasonsFromService(): string[] {
  const source = readFileSync(DELIVERY_SOURCE, "utf8");
  const reasons = new Set<string>();
  const holdPattern = /AgentInputDeliveryDecision::Hold\s*\{([\s\S]*?)\}/g;
  for (const [, body] of source.matchAll(holdPattern)) {
    for (const [, reason] of body.matchAll(/reason:\s*"([^"]+)"/g)) {
      reasons.add(reason);
    }
  }
  return [...reasons];
}

describe("the held-input reasons the service emits", () => {
  it("finds them in the Rust source, or this gate is measuring nothing", () => {
    const reasons = heldReasonsFromService();
    expect(reasons.length).toBeGreaterThan(0);
    // Named so the pattern silently matching nothing is visible rather than
    // passing an empty loop.
    expect(reasons).toContain("visible-unsubmitted-input-recent-user-input");
  });

  it("gives every one of them words rather than the enum", () => {
    for (const reason of heldReasonsFromService()) {
      const notice = formatLivePaneInputDeliveryNotice({ state: "held", reason });
      expect(notice, `${reason} must produce a notice`).toBeTruthy();
      expect(notice, `${reason} must not leak the slug`).not.toContain(reason);
      expect(notice, `${reason} needs its own wording, not the generic line`).not.toContain(
        FALLBACK,
      );
    }
  });
});
