import { describe, expect, it } from "vitest";

import { getErrorMessage, isTransientRequestError } from "./request-errors";

/// Shaped like `ApiError` rather than imported: `api.ts` pulls React Native in,
/// and what matters here is the field, not the class.
function apiError(status: number, message: string, kind?: "cancelled" | "timeout"): Error {
  return Object.assign(new Error(message), { name: "ApiError", status, body: null, kind });
}

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

  // The two banners Sam screenshotted. The filter existed to catch exactly
  // these and matched text `api.ts` had stopped writing: it looked for
  // "aborted" while the message says "Request was cancelled", and for an
  // unanchored "request timed out after Nms" while the message appends the
  // path. Both reached the user as a red banner for something already healed.
  it("treats a request the app itself cancelled as transient", () => {
    const cancelled = apiError(
      0,
      "Request was cancelled (https://relay.aimux.app/shares)",
      "cancelled",
    );
    expect(isTransientRequestError(cancelled)).toBe(true);
    expect(
      isTransientRequestError(new Error("Request was cancelled (https://relay.aimux.app/shares)")),
      // Without the kind there is nothing structural to read, which is the
      // state that produced the banner.
    ).toBe(false);
  });

  it("treats a request timeout as transient even with the path appended", () => {
    const timedOut = apiError(0, "Request timed out after 10000ms (/projects)", "timeout");
    expect(isTransientRequestError(timedOut)).toBe(true);
  });

  it("does not hide a server error that merely mentions cancelling", () => {
    const refused = apiError(409, "The run was cancelled by the operator (/runs/7)");
    expect(isTransientRequestError(refused)).toBe(false);
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
