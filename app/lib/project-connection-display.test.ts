import { describe, expect, it, vi } from "vitest";

// `serviceEndpointKey` lives beside the daemon URL resolver, which reaches the
// Expo env and then react-native.
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
import {
  formatProjectEndpointLabel,
  getProjectServiceEndpoint,
  isRuntimeInventoryUnavailableError,
  isRelayUnavailableForProjectDiscovery,
  projectStateErrorCopy,
} from "./project-connection-display";
import { serviceEndpointKey } from "@/lib/daemon-url";

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
    // The relay mints codes from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ — no 0/1/I/O.
    expect(projectStateErrorCopy("Remote client pending security approval. Code ABC-234.")).toEqual(
      {
        title: "Remote client pending approval.",
        detail:
          "Run `aimux security device approve`, match code ABC-234, then refresh project state.",
      },
    );
  });

  it("turns relay disconnection into reconnect guidance", () => {
    expect(projectStateErrorCopy("Relay not connected")).toEqual({
      title: "Remote unavailable.",
      detail: "Aimux could not reach the remote control plane. Try again after it reconnects.",
    });
  });

  it("renders unverified tmux liveness as runtime inventory unavailable", () => {
    const error =
      "could not verify agent tmux liveness: tmux socket busy: tmux window query failed: tmux list-windows timed out";

    expect(isRuntimeInventoryUnavailableError(error)).toBe(true);
    expect(projectStateErrorCopy(error)).toEqual({
      title: "Runtime inventory unavailable.",
      detail: `Aimux could not verify tmux window liveness. ${error}`,
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

describe("the machine a project service address belongs to", () => {
  // Structurally what `getProjectServiceEndpoint` reads, so this file does not
  // have to pull `@/lib/api` (and react-native with it) into the test.
  type EndpointProject = Parameters<typeof getProjectServiceEndpoint>[0];
  function project(overrides: Partial<NonNullable<EndpointProject>>): NonNullable<EndpointProject> {
    return {
      id: "aimux",
      name: "aimux",
      path: "/repo/aimux",
      dashboardSessionName: "aimux-aimux",
      service: null,
      serviceAlive: true,
      serviceEndpoint: { host: "127.0.0.1", port: 43191 },
      ...overrides,
    };
  }

  // 127.0.0.1:43191 is a different project service on each machine, so the
  // address is not an address until it says whose loopback it is.
  it("stamps the machine the project came from", () => {
    expect(getProjectServiceEndpoint(project({ machineId: "strix" }))).toEqual({
      host: "127.0.0.1",
      port: 43191,
      machineId: "strix",
    });
  });

  // Local mode and shared surfaces have one host to mean, and a key that
  // compares by value must not gain an undefined field.
  it("leaves the address alone when there is no machine", () => {
    expect(getProjectServiceEndpoint(project({}))).toEqual({ host: "127.0.0.1", port: 43191 });
    expect(getProjectServiceEndpoint(project({ serviceAlive: false }))).toBeNull();
    expect(getProjectServiceEndpoint(project({ serviceEndpoint: null }))).toBeNull();
  });

  it("keys two machines' identical addresses apart", () => {
    const mbp = getProjectServiceEndpoint(project({ machineId: "mbp" }));
    const strix = getProjectServiceEndpoint(project({ machineId: "strix" }));
    expect(serviceEndpointKey(mbp)).not.toBe(serviceEndpointKey(strix));
    expect(serviceEndpointKey(null)).toBeNull();
  });
});
