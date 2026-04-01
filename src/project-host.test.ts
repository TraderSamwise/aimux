import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { initPaths, getHostStatePath } from "./paths.js";
import {
  acquireProjectHost,
  clearProjectHost,
  heartbeatProjectHost,
  loadProjectHost,
  releaseProjectHost,
} from "./project-host.js";

const dirs: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aimux-host-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0, dirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("project-host", () => {
  it("claims, heartbeats, and releases the project host", async () => {
    const cwd = makeProject();
    await initPaths(cwd);

    const claimed = await acquireProjectHost("inst-a", cwd);
    expect(claimed.claimed).toBe(true);
    expect(claimed.host?.instanceId).toBe("inst-a");

    const heartbeated = await heartbeatProjectHost("inst-a", cwd, { metadataPort: 43123 });
    expect(heartbeated?.metadataPort).toBe(43123);

    const loaded = loadProjectHost();
    expect(loaded?.instanceId).toBe("inst-a");
    expect(loaded?.metadataPort).toBe(43123);

    await releaseProjectHost("inst-a", cwd);
    expect(loadProjectHost()).toBeNull();
  });

  it("does not replace a live host owned by another instance", async () => {
    const cwd = makeProject();
    await initPaths(cwd);

    await acquireProjectHost("inst-a", cwd);
    const second = await acquireProjectHost("inst-b", cwd);
    expect(second.claimed).toBe(false);
    expect(second.host?.instanceId).toBe("inst-a");
  });

  it("clears the host file explicitly", async () => {
    const cwd = makeProject();
    await initPaths(cwd);

    await acquireProjectHost("inst-a", cwd);
    expect(JSON.parse(readFileSync(getHostStatePath(), "utf-8"))).toMatchObject({ instanceId: "inst-a" });
    await clearProjectHost(cwd);
    expect(loadProjectHost()).toBeNull();
  });
});
