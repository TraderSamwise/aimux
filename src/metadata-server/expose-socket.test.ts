import { describe, expect, it } from "vitest";

import { parsePositiveHeaderInteger, splitExposeHeader } from "./expose-socket.js";

describe("expose socket header helpers", () => {
  it("parses positive integer header fields only", () => {
    expect(parsePositiveHeaderInteger("80")).toBe(80);
    expect(parsePositiveHeaderInteger("0")).toBeUndefined();
    expect(parsePositiveHeaderInteger("-1")).toBeUndefined();
    expect(parsePositiveHeaderInteger("abc")).toBeUndefined();
    expect(parsePositiveHeaderInteger(undefined)).toBeUndefined();
  });

  it("splits exactly after the launch header and preserves the first body chunk", () => {
    const header = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n");
    const parsed = splitExposeHeader(Buffer.from(`${header}\nbody\nrest`, "utf8"));

    expect(parsed?.header).toEqual(Array.from({ length: 15 }, (_, index) => `line-${index + 1}`));
    expect(parsed?.rest.toString("utf8")).toBe("body\nrest");
  });

  it("waits for a complete launch header", () => {
    const parsed = splitExposeHeader(Buffer.from("one\ntwo\n", "utf8"));

    expect(parsed).toBeNull();
  });
});
