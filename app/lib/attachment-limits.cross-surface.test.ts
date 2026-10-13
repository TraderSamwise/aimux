import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ATTACHMENT_MAX_BYTES } from "@/lib/attachment-limits";

/**
 * The app's attachment limit is the project service's attachment limit.
 *
 * The client has to know the number before it uploads — asking the service by
 * making a request is the failed round trip this check exists to avoid — so
 * the constant is duplicated. This reads the Rust source and fails if the two
 * drift, which is the only thing that makes duplicating it safe.
 */

const ATTACHMENTS_SOURCE = join(
  import.meta.dirname,
  "..",
  "..",
  "native",
  "crates",
  "aimux",
  "src",
  "project_service",
  "attachments.rs",
);

/** `pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;` */
function serviceAttachmentMaxBytes(): number {
  const source = readFileSync(ATTACHMENTS_SOURCE, "utf8");
  const match = source.match(/MAX_ATTACHMENT_BYTES:\s*usize\s*=\s*([0-9_ *]+);/);
  expect(match, "MAX_ATTACHMENT_BYTES must be findable in attachments.rs").toBeTruthy();
  const expression = match![1].replace(/_/g, "").trim();
  // Only the `N * N * N` form the constant is written in; anything else should
  // fail loudly rather than be guessed at.
  expect(expression).toMatch(/^[0-9]+(\s*\*\s*[0-9]+)*$/);
  return expression
    .split("*")
    .map((part) => Number(part.trim()))
    .reduce((product, part) => product * part, 1);
}

describe("the attachment size limit", () => {
  it("matches the project service's own constant", () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(serviceAttachmentMaxBytes());
  });

  it("is a real limit, not a placeholder", () => {
    // Guards the parser returning 1 from an empty match, and the constant
    // being set to something that would reject ordinary photos again.
    expect(serviceAttachmentMaxBytes()).toBeGreaterThan(5 * 1024 * 1024);
  });
});
