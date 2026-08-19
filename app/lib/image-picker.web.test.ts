import { describe, expect, it } from "vitest";

import { isAcceptedImageFile } from "./image-picker.web";

describe("isAcceptedImageFile", () => {
  it("accepts supported image formats", () => {
    expect(isAcceptedImageFile({ type: "image/png" })).toBe(true);
    expect(isAcceptedImageFile({ type: "image/jpeg" })).toBe(true);
    expect(isAcceptedImageFile({ type: "image/webp" })).toBe(true);
    expect(isAcceptedImageFile({ type: "image/gif" })).toBe(true);
  });

  it("rejects non-image and unsupported image formats", () => {
    expect(isAcceptedImageFile({ type: "text/plain" })).toBe(false);
    expect(isAcceptedImageFile({ type: "application/pdf" })).toBe(false);
    // iOS shares photos as HEIC, so every image/* type is accepted.
    expect(isAcceptedImageFile({ type: "image/heic" })).toBe(true);
  });
});
