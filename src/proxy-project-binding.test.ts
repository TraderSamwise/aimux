import { describe, expect, it } from "vitest";

import {
  parseProxyTarget,
  resolveProjectRootForServiceTarget,
  type ProxyBindingCandidate,
} from "./proxy-project-binding.js";

const HOST = "127.0.0.1";

function candidate(path: string, port: number | null, serviceAlive = true, host: string = HOST): ProxyBindingCandidate {
  return { path, serviceAlive, serviceEndpoint: port === null ? null : { host, port } };
}

describe("parseProxyTarget", () => {
  it("reads host and port out of a proxy path", () => {
    expect(parseProxyTarget("/proxy/127.0.0.1/43210/agents/output")).toEqual({ host: "127.0.0.1", port: 43210 });
  });

  it("returns null for anything that is not a proxy path", () => {
    for (const path of ["/health", "/agents/output", "/proxy/127.0.0.1/43210", "/proxy/127.0.0.1/abc/agents"]) {
      expect(parseProxyTarget(path), path).toBeNull();
    }
  });

  it("rejects a zero port in the path", () => {
    expect(parseProxyTarget("/proxy/127.0.0.1/0/agents/output")).toBeNull();
  });
});

describe("resolveProjectRootForServiceTarget", () => {
  const target = (port: number, host: string = HOST) => ({ host, port });

  it("binds a port to its live project", () => {
    const projects = [candidate("/srv/a", 43210), candidate("/srv/b", 43211)];
    expect(resolveProjectRootForServiceTarget(projects, target(43210))).toBe("/srv/a");
  });

  it("ignores a project whose service is not alive", () => {
    // The failure this prevents: project A dies ungracefully leaving its
    // endpoint file behind, the OS recycles the ephemeral port to project B,
    // and a grant on A would otherwise authorize a request that reaches B.
    const projects = [candidate("/srv/dead", 51000, false), candidate("/srv/live", 51000, true)];
    expect(resolveProjectRootForServiceTarget(projects, target(51000))).toBe("/srv/live");
  });

  it("refuses to guess when two live projects claim the same port", () => {
    const projects = [candidate("/srv/a", 51000), candidate("/srv/b", 51000)];
    expect(resolveProjectRootForServiceTarget(projects, target(51000))).toBeNull();
  });

  it("requires the host to match the recorded endpoint", () => {
    // "localhost" can answer on ::1, a different listener from the 127.0.0.1
    // the endpoint recorded.
    const projects = [candidate("/srv/a", 43210)];
    expect(resolveProjectRootForServiceTarget(projects, target(43210, "localhost"))).toBeNull();
    expect(resolveProjectRootForServiceTarget(projects, target(43210, "::1"))).toBeNull();
  });

  it("returns null when only a dead project claims the port", () => {
    expect(resolveProjectRootForServiceTarget([candidate("/srv/dead", 51000, false)], target(51000))).toBeNull();
  });

  it("returns null for an unknown port, a null endpoint, or a pathless project", () => {
    expect(resolveProjectRootForServiceTarget([candidate("/srv/a", 43210)], target(43999))).toBeNull();
    expect(resolveProjectRootForServiceTarget([candidate("/srv/a", null)], target(43210))).toBeNull();
    expect(resolveProjectRootForServiceTarget([candidate("", 43210)], target(43210))).toBeNull();
    expect(resolveProjectRootForServiceTarget([], target(43210))).toBeNull();
  });

  it("rejects nonsense ports even when a candidate records one", () => {
    expect(resolveProjectRootForServiceTarget([candidate("/srv/a", 0)], target(0))).toBeNull();
    expect(resolveProjectRootForServiceTarget([candidate("/srv/a", -1)], target(-1))).toBeNull();
    expect(resolveProjectRootForServiceTarget([candidate("/srv/a", Number.NaN)], target(Number.NaN))).toBeNull();
    expect(resolveProjectRootForServiceTarget([candidate("/srv/a", 1.5)], target(1.5))).toBeNull();
  });

  it("returns null for a missing target or empty host", () => {
    expect(resolveProjectRootForServiceTarget([candidate("/srv/a", 43210)], null)).toBeNull();
    expect(resolveProjectRootForServiceTarget([candidate("/srv/a", 43210)], target(43210, ""))).toBeNull();
  });
});
