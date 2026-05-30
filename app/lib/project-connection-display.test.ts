import { describe, expect, it } from "vitest";
import { formatProjectEndpointLabel, projectStateErrorCopy } from "./project-connection-display";

describe("formatProjectEndpointLabel", () => {
  it("does not expose loopback metadata endpoints in relay mode", () => {
    expect(formatProjectEndpointLabel({ host: "127.0.0.1", port: 46975 }, "relay")).toBe(
      "via relay",
    );
  });

  it("shows the direct endpoint in local mode", () => {
    expect(formatProjectEndpointLabel({ host: "127.0.0.1", port: 46975 }, "local")).toBe(
      "127.0.0.1:46975",
    );
  });

  it("shows an offline label when no project host exists", () => {
    expect(formatProjectEndpointLabel(null, "relay")).toBe("host offline");
  });
});

describe("projectStateErrorCopy", () => {
  it("turns pending security approval into actionable copy", () => {
    expect(projectStateErrorCopy("Remote client pending security approval")).toEqual({
      title: "Remote client pending approval.",
      detail: "Open Inbox and approve this device, then refresh project state.",
    });
  });
});
