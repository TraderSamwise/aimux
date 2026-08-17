import { describe, expect, it } from "vitest";

import { cropExposePreviewFooter, exposePreviewFooterCropRows } from "./expose-preview-crop.js";

describe("expose preview footer cropping", () => {
  it("crops more bottom rows as the preview gets shorter", () => {
    expect(exposePreviewFooterCropRows(6)).toBe(3);
    expect(exposePreviewFooterCropRows(10)).toBe(2);
    expect(exposePreviewFooterCropRows(13)).toBe(1);
    expect(exposePreviewFooterCropRows(16)).toBe(0);
  });

  it("slides older content up rather than shrinking the rendered preview", () => {
    const lines = ["content 1", "content 2", "content 3", "footer 1", "footer 2", "footer 3"];

    expect(cropExposePreviewFooter(lines, 3)).toEqual(["content 1", "content 2", "content 3"]);
  });

  it("does not crop when there are no replacement rows", () => {
    expect(cropExposePreviewFooter(["one", "two", "three"], 3)).toEqual(["one", "two", "three"]);
  });
});
