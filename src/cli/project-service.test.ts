import { describe, expect, it } from "vitest";
import {
  coreProjectServicePid,
  findCoreProject,
  ProjectServiceVersionError,
  renderProjectServiceVersionHelp,
} from "./project-service.js";
import type { CoreStatusProject } from "../core-command-contract.js";

describe("cli project-service helpers", () => {
  it("matches projects by resolved path", () => {
    const projects = [
      { path: "/tmp/aimux/a/../a", service: { pid: 123 } },
      { path: "/tmp/aimux/b", service: null },
    ] as CoreStatusProject[];

    expect(findCoreProject(projects, "/tmp/aimux/a")?.path).toBe("/tmp/aimux/a/../a");
    expect(findCoreProject(projects, "/tmp/aimux/c")).toBeNull();
  });

  it("reads numeric project service pids only", () => {
    expect(coreProjectServicePid({ service: { pid: 123 } } as CoreStatusProject)).toBe(123);
    expect(coreProjectServicePid({ service: { pid: "123" } } as unknown as CoreStatusProject)).toBeNull();
    expect(coreProjectServicePid(null)).toBeNull();
  });

  it("renders stale project-service build help", () => {
    const error = new ProjectServiceVersionError(
      "stale",
      "/repo",
      { version: "local-a", buildStamp: "local-a" },
      { version: "local-b", buildStamp: "local-b" },
    );

    expect(renderProjectServiceVersionHelp(error)).toContain("Project: /repo");
    expect(renderProjectServiceVersionHelp(error)).toContain("Expected build: local-a");
    expect(renderProjectServiceVersionHelp(error)).toContain("Running build: local-b");
  });
});
