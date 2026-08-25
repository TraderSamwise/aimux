import { describe, expect, it } from "vitest";

import { attachmentsFromClipboardData, isAcceptedImageFile } from "./image-picker.web";

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

describe("attachmentsFromClipboardData", () => {
  it("reads pasted image files", async () => {
    const attachment = await attachmentsFromClipboardData({
      files: [new File(["hello"], "clip.png", { type: "image/png" })],
    });

    expect(attachment).toHaveLength(1);
    expect(attachment[0]).toMatchObject({
      filename: "clip.png",
      kind: "image",
      mimeType: "image/png",
    });
    expect(attachment[0]?.dataBase64).toBe("aGVsbG8=");
  });

  it("falls back to clipboard items when files is empty", async () => {
    const attachment = await attachmentsFromClipboardData({
      files: [],
      items: [
        {
          kind: "file",
          getAsFile: () => new File(["hello"], "item.png", { type: "image/png" }),
        },
      ],
    });

    expect(attachment[0]?.filename).toBe("item.png");
  });

  it("ignores plain text paste", async () => {
    await expect(
      attachmentsFromClipboardData({
        files: [],
        items: [{ kind: "string", getAsFile: () => null }],
      }),
    ).resolves.toEqual([]);
  });
});
