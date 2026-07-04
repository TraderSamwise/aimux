import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const shimPath = join(process.cwd(), "scripts", "installed-aimux-shim.sh");

function makeFixture() {
  const root = join(tmpdir(), `aimux-installed-shim-${process.pid}-${Date.now()}-${Math.random()}`);
  const aimuxRoot = join(root, "aimux");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(aimuxRoot, "dist"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(aimuxRoot, "BUILD_STAMP"), "build-1\n");
  writeFileSync(join(aimuxRoot, "dist", "launcher-bin.js"), "");

  const healthFile = join(root, "health.json");
  const lockPath = join(home, "locks", "daemon-start");
  const nodeLog = join(root, "node.log");
  const curlPath = join(bin, "curl");
  const nodePath = join(bin, "node");

  writeFileSync(
    curlPath,
    `#!/usr/bin/env sh
set -eu
[ -f "$HEALTH_FILE" ] || exit 22
cat "$HEALTH_FILE"
`,
  );
  writeFileSync(
    nodePath,
    `#!/usr/bin/env sh
set -eu
printf '%s\\n' "$*" >> "$NODE_LOG"
if [ "\${NODE_MODE:-fallback}" = "start" ]; then
  printf '%s\\n' "$START_HEALTH" > "$HEALTH_FILE"
  exit 0
fi
exit "\${NODE_EXIT:-7}"
`,
  );
  chmodSync(curlPath, 0o755);
  chmodSync(nodePath, 0o755);

  const env = {
    ...process.env,
    AIMUX_ROOT: aimuxRoot,
    AIMUX_NODE_BIN: nodePath,
    AIMUX_HOME: home,
    AIMUX_DAEMON_PORT: "45678",
    HEALTH_FILE: healthFile,
    NODE_LOG: nodeLog,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync("sh", [shimPath, ...args], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
    });

  return { aimuxRoot, healthFile, lockPath, nodeLog, run };
}

function health(buildStamp: string, pid = 123, port = 45678): string {
  return JSON.stringify({
    kind: "aimux-daemon",
    ok: true,
    pid,
    port,
    serviceInfo: { apiVersion: 4, capabilities: {}, buildStamp },
  });
}

describe("installed aimux shim", () => {
  it("serves daemon ensure from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);

    const result = fixture.run(["daemon", "ensure"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("aimux daemon: pid 321 on http://127.0.0.1:45678\n");
    expect(result.stderr).toBe("");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for stale daemon health", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build")}\n`);

    const result = fixture.run(["daemon", "ensure"], { NODE_EXIT: "17" });

    expect(result.status).toBe(17);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js daemon ensure\n`);
  });

  it("falls back to the Node launcher for non-fast-path commands", () => {
    const fixture = makeFixture();

    const result = fixture.run(["restart"], { NODE_EXIT: "19" });

    expect(result.status).toBe(19);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js restart\n`);
  });

  it("starts the daemon process and waits for matching health when no daemon is live", () => {
    const fixture = makeFixture();

    const result = fixture.run(["daemon", "ensure"], {
      NODE_MODE: "start",
      START_HEALTH: health("build-1", 654),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("aimux daemon: pid 654 on http://127.0.0.1:45678\n");
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js daemon run\n`);
    expect(existsSync(fixture.lockPath)).toBe(false);
  });
});
