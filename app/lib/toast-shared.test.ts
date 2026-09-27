import { describe, expect, it } from "vitest";

import { compactToastText, toastErrorMessage, toastIdForOperation } from "./toast-shared";

describe("a toast carries the failure, not a shrug", () => {
  it("uses the error's own message", () => {
    expect(toastErrorMessage(new Error("HTTP 502 from /projects"), "fallback")).toBe(
      "HTTP 502 from /projects",
    );
  });

  it("reads a message off a thrown object that is not an Error", () => {
    expect(toastErrorMessage({ status: 403, message: "shared guests cannot access" }, "x")).toBe(
      "shared guests cannot access",
    );
  });

  it("takes a thrown string", () => {
    expect(toastErrorMessage("socket hang up", "fallback")).toBe("socket hang up");
  });

  it("falls back only when there is genuinely nothing to say", () => {
    expect(toastErrorMessage(null, "Could not load projects")).toBe("Could not load projects");
    expect(toastErrorMessage(new Error(""), "Could not load projects")).toBe(
      "Could not load projects",
    );
    expect(toastErrorMessage({ message: "   " }, "Could not load projects")).toBe(
      "Could not load projects",
    );
  });
});

describe("toast text stays readable", () => {
  it("collapses whitespace so a multi-line error does not wreck the toast", () => {
    expect(compactToastText("  line one\n\n  line two  ")).toBe("line one line two");
  });

  it("truncates rather than overflowing", () => {
    const long = "x".repeat(400);
    const compacted = compactToastText(long);
    expect(compacted.length).toBe(220);
    expect(compacted.endsWith("…")).toBe(true);
  });

  it("leaves a message that already fits alone", () => {
    expect(compactToastText("Could not load projects")).toBe("Could not load projects");
  });
});

describe("a repeating failure replaces its toast", () => {
  // The project list polls every ten seconds. Without a stable id, an hour of
  // being offline is 360 stacked toasts, which is its own kind of unusable.
  it("keys by the operation so the same failure reuses one toast", () => {
    expect(toastIdForOperation("project-list")).toBe(toastIdForOperation("project-list"));
    expect(toastIdForOperation("project-list")).not.toBe(toastIdForOperation("shared-chats"));
  });
});
