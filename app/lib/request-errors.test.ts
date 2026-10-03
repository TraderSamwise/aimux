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

  it("treats closed transport writes as transient", () => {
    expect(isTransientRequestError(new Error("write EPIPE"))).toBe(true);
    expect(
      isTransientRequestError(Object.assign(new Error("socket closed"), { code: "ECONNRESET" })),
    ).toBe(true);
  });

  it("does not hide unexpected errors", () => {
    expect(isTransientRequestError(new Error("Route is not allowed for this shared chat"))).toBe(
      false,
    );
  });
});

describe("an error that enumerates what failed", () => {
  // The all-machines-failed error joins each machine's own message, and any
  // one of those can contain "failed to fetch". Matching on the text would
  // file a whole fleet being unreachable as something to ignore.
  it("is never transient, whatever the text says", () => {
    expect(
      isTransientRequestError(
        Object.assign(new Error("No machine answered — sam-mbp: failed to fetch"), {
          body: {
            failures: [{ machineId: "mbp", machineName: "sam-mbp", error: "failed to fetch" }],
          },
        }),
      ),
    ).toBe(false);
  });

  it("still treats a bare blip as transient", () => {
    expect(isTransientRequestError(new Error("failed to fetch"))).toBe(true);
    expect(
      isTransientRequestError(
        Object.assign(new Error("failed to fetch"), { body: { failures: [] } }),
      ),
    ).toBe(true);
  });
});
