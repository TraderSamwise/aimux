import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  registerInstance,
  unregisterInstance,
  updateHeartbeat,
  claimSession,
  getRemoteInstances,
  type InstanceSessionRef,
} from "./instance-registry.js";

function makeTmpRepo(): string {
  // realpathSync to resolve macOS /tmp -> /private/tmp symlink
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aimux-test-")));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "pipe" });
  mkdirSync(join(dir, ".aimux"), { recursive: true });
  writeFileSync(join(dir, ".aimux", "instances.json"), "[]");
  return dir;
}

function readInstances(cwd: string): Array<{ instanceId: string; sessions: InstanceSessionRef[] }> {
  const raw = readFileSync(join(cwd, ".aimux", "instances.json"), "utf-8");
  return JSON.parse(raw);
}

describe("instance-registry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("registerInstance + unregisterInstance", () => {
    it("registers an instance with current PID", async () => {
      await registerInstance("inst-a", tmpDir);

      const instances = readInstances(tmpDir);
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

      const instances = readInstances(tmpDir);
      expect(instances).toHaveLength(0);
    });
  });

  describe("updateHeartbeat", () => {
    it("updates sessions list and heartbeat timestamp", async () => {
      await registerInstance("inst-a", tmpDir);

      const sessions: InstanceSessionRef[] = [{ id: "claude-123", tool: "claude" }];
      await updateHeartbeat("inst-a", sessions, tmpDir);

      const instances = readInstances(tmpDir);
      expect(instances[0].sessions).toHaveLength(1);
      expect(instances[0].sessions[0].id).toBe("claude-123");
    });

    it("returns previous session IDs for claim detection", async () => {
      await registerInstance("inst-a", tmpDir);

      // First heartbeat: register sessions
      const sessions: InstanceSessionRef[] = [
        { id: "claude-123", tool: "claude", backendSessionId: "uuid-1" },
        { id: "claude-456", tool: "claude", backendSessionId: "uuid-2" },
      ];
      const prev1 = await updateHeartbeat("inst-a", sessions, tmpDir);
      // First heartbeat: registry was empty before
      expect(prev1).toEqual([]);

      // Second heartbeat: registry had our sessions
      const prev2 = await updateHeartbeat("inst-a", sessions, tmpDir);
      expect(prev2).toContain("claude-123");
      expect(prev2).toContain("claude-456");
    });

    it("caller can detect claims by comparing previousIds vs confirmed set", async () => {
      await registerInstance("inst-a", tmpDir);

      const sessions: InstanceSessionRef[] = [
        { id: "claude-123", tool: "claude", backendSessionId: "uuid-1" },
        { id: "claude-456", tool: "claude", backendSessionId: "uuid-2" },
      ];
      await updateHeartbeat("inst-a", sessions, tmpDir);

      // Simulate claim
      await claimSession("claude-123", "inst-a", tmpDir);

      // Next heartbeat returns what was in registry (only claude-456 remains)
      const previousIds = await updateHeartbeat("inst-a", sessions, tmpDir);
      expect(previousIds).toContain("claude-456");
      expect(previousIds).not.toContain("claude-123");

      // Caller detects: "claude-123" was confirmed but not in previousIds → claimed
      const confirmed = new Set(["claude-123", "claude-456"]);
      const claimed = [...confirmed].filter((id) => !previousIds.includes(id));
      expect(claimed).toEqual(["claude-123"]);

      // Registry should have all sessions (updateHeartbeat writes what we send)
      const instances = readInstances(tmpDir);
      const instA = instances.find((i: { instanceId: string }) => i.instanceId === "inst-a");
      expect(instA?.sessions).toHaveLength(2);
    });
  });

  describe("claimSession", () => {
    it("removes session from source instance and returns it", async () => {
      await registerInstance("inst-a", tmpDir);
      const sessions: InstanceSessionRef[] = [{ id: "claude-123", tool: "claude", backendSessionId: "uuid-1" }];
      await updateHeartbeat("inst-a", sessions, tmpDir);

      const claimed = await claimSession("claude-123", "inst-a", tmpDir);
      expect(claimed).toBeDefined();
      expect(claimed!.id).toBe("claude-123");
      expect(claimed!.backendSessionId).toBe("uuid-1");

      // Session should be removed from inst-a
      const instances = readInstances(tmpDir);
      const instA = instances.find((i: { instanceId: string }) => i.instanceId === "inst-a");
      expect(instA?.sessions ?? []).toHaveLength(0);
    });

    it("returns undefined for non-existent session", async () => {
      await registerInstance("inst-a", tmpDir);

      const claimed = await claimSession("nonexistent", "inst-a", tmpDir);
      expect(claimed).toBeUndefined();
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
