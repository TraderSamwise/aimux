import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_MAX_BYTES,
  attachmentExceedsLimit,
  attachmentTooLargeMessage,
  firstOversizedAttachment,
} from "@/lib/attachment-limits";

describe("whether an attachment fits", () => {
  it("accepts what is under the limit, including exactly the limit", () => {
    expect(attachmentExceedsLimit(0)).toBe(false);
    expect(attachmentExceedsLimit(1024)).toBe(false);
    expect(attachmentExceedsLimit(ATTACHMENT_MAX_BYTES)).toBe(false);
  });

  it("refuses what is over it", () => {
    expect(attachmentExceedsLimit(ATTACHMENT_MAX_BYTES + 1)).toBe(true);
  });

  // A picker that did not report a size is not evidence the file is too big,
  // and refusing it would block an upload that would have worked.
  it("does not refuse a file whose size is unknown", () => {
    expect(attachmentExceedsLimit(undefined)).toBe(false);
  });
});

describe("what it says about a file that is too large", () => {
  // "Too large" without a number is the guessing this exists to remove.
  it("names the file, its size and the limit", () => {
    expect(
      attachmentTooLargeMessage({ filename: "IMG_0042.HEIC", sizeBytes: 12 * 1024 * 1024 }),
    ).toBe("IMG_0042.HEIC is 12 MB. Attachments can be up to 10 MB.");
  });

  it("keeps a decimal where it carries information", () => {
    expect(
      attachmentTooLargeMessage({ filename: "a.png", sizeBytes: 1.5 * 1024 * 1024 }),
    ).toContain("1.5 MB");
  });
});

describe("checking a whole set before uploading any of it", () => {
  // The send loop uploads one at a time inside the send's `try`, so a
  // rejection partway through abandons the send with some files already
  // stored. The set is checked first.
  it("finds the first file that does not fit", () => {
    const attachments = [
      { filename: "small.png", sizeBytes: 1024 },
      { filename: "huge.png", sizeBytes: ATTACHMENT_MAX_BYTES + 1 },
      { filename: "also-huge.png", sizeBytes: ATTACHMENT_MAX_BYTES + 2 },
    ];
    expect(firstOversizedAttachment(attachments)?.filename).toBe("huge.png");
  });

  it("passes a set that all fits", () => {
    expect(firstOversizedAttachment([{ filename: "a.png", sizeBytes: 1024 }])).toBeNull();
    expect(firstOversizedAttachment([])).toBeNull();
  });
});
