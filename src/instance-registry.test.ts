import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// Mock paths module so instances.json lives in tmpDir
let tmpDir: string;
vi.mock("./paths.js", () => ({
  getInstancesPath: () => join(tmpDir, "instances.json"),
  getAimuxDirFor: (cwd: string) => join(cwd, ".aimux"),
}));

import {
  registerInstance,
  unregisterInstance,
  updateHeartbeat,
  getRemoteInstances,
  type InstanceSessionRef,
} from "./instance-registry.js";

function runGit(args: string, dir: string): void {
  // Strip inherited GIT_* env so commands honor `cwd` even when invoked under a git hook.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execSync(`git ${args}`, { cwd: dir, stdio: "pipe", env });
}

function makeTmpRepo(): string {
  // realpathSync to resolve macOS /tmp -> /private/tmp symlink
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aimux-test-")));
  runGit("init", dir);
  runGit("config user.email test@example.com", dir);
  runGit("config user.name test", dir);
  runGit("commit --allow-empty -m init", dir);
  mkdirSync(join(dir, ".aimux"), { recursive: true });
  writeFileSync(join(dir, "instances.json"), "[]");
  return dir;
}

function readInstances(): Array<{ instanceId: string; sessions: InstanceSessionRef[] }> {
  const raw = readFileSync(join(tmpDir, "instances.json"), "utf-8");
  return JSON.parse(raw);
}

describe("instance-registry", () => {
  beforeEach(() => {
    tmpDir = makeTmpRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("registerInstance + unregisterInstance", () => {
    it("registers an instance with current PID", async () => {
      await registerInstance("inst-a", tmpDir);

      const instances = readInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0].instanceId).toBe("inst-a");
    });

    it("returns other live instances on registration", async () => {
      await registerInstance("inst-a", tmpDir);
      const others = await registerInstance("inst-b", tmpDir);

      // inst-a uses our PID so it's "alive"
      expect(others.length).toBe(1);
      expect(others[0].instanceId).toBe("inst-a");
    });

    it("unregisters an instance", async () => {
      await registerInstance("inst-a", tmpDir);
      await unregisterInstance("inst-a", tmpDir);

      const instances = readInstances();
      expect(instances).toHaveLength(0);
    });
  });

  describe("updateHeartbeat", () => {
    it("updates heartbeat timestamp without persisting session refs", async () => {
      await registerInstance("inst-a", tmpDir);

      const sessions: InstanceSessionRef[] = [{ id: "claude-123", tool: "claude" }];
      await updateHeartbeat("inst-a", sessions, tmpDir);

      const instances = readInstances();
      expect(instances[0].sessions).toEqual([]);
    });

    it("does not return previous session IDs for claim detection", async () => {
      await registerInstance("inst-a", tmpDir);

      // First heartbeat: register sessions
      const sessions: InstanceSessionRef[] = [
        { id: "claude-123", tool: "claude", backendSessionId: "uuid-1" },
        { id: "claude-456", tool: "claude", backendSessionId: "uuid-2" },
      ];
      const prev1 = await updateHeartbeat("inst-a", sessions, tmpDir);
      expect(prev1).toEqual([]);

      const prev2 = await updateHeartbeat("inst-a", sessions, tmpDir);
      expect(prev2).toEqual([]);
    });

    it("keeps the registry liveness-only across repeated heartbeats", async () => {
      await registerInstance("inst-a", tmpDir);

      const sessions: InstanceSessionRef[] = [
        { id: "claude-123", tool: "claude", backendSessionId: "uuid-1" },
        { id: "claude-456", tool: "claude", backendSessionId: "uuid-2" },
      ];
      await updateHeartbeat("inst-a", sessions, tmpDir);

      const previousIds = await updateHeartbeat("inst-a", sessions, tmpDir);
      expect(previousIds).toEqual([]);

      const instances = readInstances();
      const instA = instances.find((i: { instanceId: string }) => i.instanceId === "inst-a");
      expect(instA?.sessions).toEqual([]);
    });
  });

  describe("getRemoteInstances", () => {
    it("returns instances other than our own", async () => {
      await registerInstance("inst-a", tmpDir);
      await registerInstance("inst-b", tmpDir);

      const remote = getRemoteInstances("inst-a", tmpDir);
      expect(remote).toHaveLength(1);
      expect(remote[0].instanceId).toBe("inst-b");
    });

    it("returns empty array when alone", async () => {
      await registerInstance("inst-a", tmpDir);

      const remote = getRemoteInstances("inst-a", tmpDir);
      expect(remote).toHaveLength(0);
    });
  });
});
