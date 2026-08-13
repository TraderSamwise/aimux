import { describe, expect, it } from "vitest";

import { getErrorMessage, isTransientRequestError } from "./request-errors";

describe("getErrorMessage", () => {
  it("returns Error messages and stringifies non-errors", () => {
    expect(getErrorMessage(new Error("nope"))).toBe("nope");
    expect(getErrorMessage("plain")).toBe("plain");
  });
});

describe("isTransientRequestError", () => {
  it("treats relay handoff disconnects as transient", () => {
    expect(isTransientRequestError(new Error("Relay not connected"))).toBe(true);
  });

  it("does not hide unexpected errors", () => {
    expect(isTransientRequestError(new Error("Route is not allowed for this shared chat"))).toBe(
      false,
    );
  });
});
