import { describe, expect, it } from "vitest";
import {
  formatProjectEndpointLabel,
  getProjectServiceEndpoint,
  isRelayUnavailableForProjectDiscovery,
  projectStateErrorCopy,
} from "./project-connection-display";

const endpoint = { host: "127.0.0.1", port: 46975 };

describe("formatProjectEndpointLabel", () => {
  it("does not expose loopback metadata endpoints in relay mode", () => {
    expect(formatProjectEndpointLabel(endpoint, "relay")).toBe("via relay");
  });

  it("shows the direct endpoint in local mode", () => {
    expect(formatProjectEndpointLabel(endpoint, "local")).toBe("127.0.0.1:46975");
  });

  it("shows an offline label when no project host exists", () => {
    expect(formatProjectEndpointLabel(null, "relay")).toBe("host offline");
  });
});

describe("getProjectServiceEndpoint", () => {
  it("returns the endpoint only when the project host is alive", () => {
    expect(
      getProjectServiceEndpoint({
        id: "project_1",
        name: "app",
        path: "/repo",
        dashboardSessionName: "aimux-app",
        service: null,
        serviceAlive: true,
        serviceEndpoint: endpoint,
      }),
    ).toBe(endpoint);
  });

  it("ignores stale endpoints when the project host is offline", () => {
    expect(
      getProjectServiceEndpoint({
        id: "project_1",
        name: "app",
        path: "/repo",
        dashboardSessionName: "aimux-app",
        service: null,
        serviceAlive: false,
        serviceEndpoint: endpoint,
      }),
    ).toBeNull();
  });
});

describe("projectStateErrorCopy", () => {
  it("turns refused metadata connections into the normal offline host state", () => {
    expect(projectStateErrorCopy("connect ECONNREFUSED 127.0.0.1:51513")).toEqual({
      title: "Project host not running.",
      detail: "Start the host to see worktrees, agents, and services for this project.",
    });
  });

  it("turns pending security approval into actionable copy", () => {
    expect(projectStateErrorCopy("Remote client pending security approval")).toEqual({
      title: "Remote client pending approval.",
      detail: "Run `aimux security device approve`, match the code, then refresh project state.",
    });
  });

  it("surfaces pending security approval codes when the relay provides one", () => {
    expect(projectStateErrorCopy("Remote client pending security approval. Code ABC-123.")).toEqual(
      {
        title: "Remote client pending approval.",
        detail:
          "Run `aimux security device approve`, match code ABC-123, then refresh project state.",
      },
    );
  });

  it("turns relay disconnection into reconnect guidance", () => {
    expect(projectStateErrorCopy("Relay not connected")).toEqual({
      title: "Remote unavailable.",
      detail: "Aimux could not reach the remote control plane. Try again after it reconnects.",
    });
  });

  it("falls back to generic copy with the original error detail", () => {
    expect(projectStateErrorCopy("Unexpected daemon timeout")).toEqual({
      title: "Could not load project state.",
      detail: "Unexpected daemon timeout",
    });
  });
});

describe("isRelayUnavailableForProjectDiscovery", () => {
  it("only treats terminal relay states as discovery unavailable", () => {
    expect(isRelayUnavailableForProjectDiscovery("daemon_offline")).toBe(true);
    expect(isRelayUnavailableForProjectDiscovery("relay_unavailable")).toBe(true);
    expect(isRelayUnavailableForProjectDiscovery("auth_failed")).toBe(true);
    expect(isRelayUnavailableForProjectDiscovery("disconnected")).toBe(false);
    expect(isRelayUnavailableForProjectDiscovery("connecting")).toBe(false);
    expect(isRelayUnavailableForProjectDiscovery("connected")).toBe(false);
  });
});
