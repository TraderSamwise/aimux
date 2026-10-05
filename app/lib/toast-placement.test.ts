import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// Read as source rather than rendered: `AppToaster` is a `sonner-native`
/// component on one platform and a `sonner` one on the other, and the question
/// is which edge each is configured for — not what either renders.
///
/// The two files are separate implementations of one decision, which is why
/// this asserts them together. A banner moved on web and left at the bottom on
/// device is the same bug reported twice.
const SURFACES = ["lib/toast.tsx", "lib/toast.web.tsx"] as const;

describe("toast placement", () => {
  it("anchors banners at the top on every platform", () => {
    for (const surface of SURFACES) {
      // Relative to the app root, which is where vitest runs. Asserted rather
      // than assumed, so a cwd surprise fails loudly instead of reading an
      // empty string and passing.
      expect(existsSync(surface), `${surface} is readable from the test cwd`).toBe(true);
      const source = readFileSync(surface, "utf8");
      expect(source, `${surface} must anchor its toaster at the top`).toContain(
        'position="top-center"',
      );
      // At the bottom these sit over the agent transcript you are reading, and
      // an error about a project list covered the sentence you were mid-way
      // through.
      expect(source, `${surface} must not put banners back over the content`).not.toContain(
        'position="bottom-center"',
      );
    }
  });
});
