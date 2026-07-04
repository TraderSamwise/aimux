import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const shimPath = join(process.cwd(), "scripts", "installed-aimux-shim.sh");
const installPath = join(process.cwd(), "scripts", "install.sh");

function makeFixture() {
  const root = join(tmpdir(), `aimux-installed-shim-${process.pid}-${Date.now()}-${Math.random()}`);
  const aimuxRoot = join(root, "aimux");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(aimuxRoot, "dist"), { recursive: true });
  mkdirSync(join(home, "daemon"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(aimuxRoot, "BUILD_STAMP"), "build-1\n");
  writeFileSync(join(aimuxRoot, "dist", "launcher-bin.js"), "");

  const healthFile = join(root, "health.json");
  const restartFile = join(root, "restart.txt");
  const daemonInfoPath = join(home, "daemon", "daemon.json");
  const nodeLog = join(root, "node.log");
  const curlPath = join(bin, "curl");
  const nodePath = join(bin, "node");

  writeFileSync(
    curlPath,
    `#!/usr/bin/env sh
set -eu
url=""
output_file=""
write_status=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      output_file="$1"
      ;;
    -w)
      shift
      write_status="$1"
      ;;
    http://*)
      url="$1"
      ;;
  esac
  shift
done
case "$url" in
  */core/restart-text)
    [ -f "$RESTART_FILE" ] || exit 22
    if [ -n "$output_file" ]; then
      cat "$RESTART_FILE" > "$output_file"
    else
      cat "$RESTART_FILE"
    fi
    [ -n "$write_status" ] && printf '%s' "\${RESTART_STATUS:-200}"
    ;;
  *)
    [ -f "$HEALTH_FILE" ] || exit 22
    cat "$HEALTH_FILE"
    ;;
esac
`,
  );
  writeFileSync(
    nodePath,
    `#!/usr/bin/env sh
set -eu
printf '%s\\n' "$*" >> "$NODE_LOG"
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
    RESTART_FILE: restartFile,
    NODE_LOG: nodeLog,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync("sh", [shimPath, ...args], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
    });

  return { aimuxRoot, daemonInfoPath, healthFile, restartFile, nodeLog, run };
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
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "ensure"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("aimux daemon: pid 321 on http://127.0.0.1:45678\n");
    expect(result.stderr).toBe("");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for stale daemon health", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build")}\n`);
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 123, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "ensure"], { NODE_EXIT: "17" });

    expect(result.status).toBe(17);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js daemon ensure\n`);
  });

  it("falls back to the Node launcher when daemon state is missing", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1")}\n`);

    const result = fixture.run(["daemon", "ensure"], { NODE_EXIT: "23" });

    expect(result.status).toBe(23);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js daemon ensure\n`);
  });

  it("falls back to the Node launcher when daemon state and health pid disagree", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 123)}\n`);
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 999, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "ensure"], { NODE_EXIT: "29" });

    expect(result.status).toBe(29);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js daemon ensure\n`);
  });

  it("serves restart from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.restartFile, "Aimux Restart\n  failures: 0\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["restart"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Aimux Restart\n  failures: 0\n");
    expect(result.stderr).toBe("");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("returns restart failures from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.restartFile, "Aimux Restart\n  failures: 1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["restart"], { RESTART_STATUS: "500" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("Aimux Restart\n  failures: 1\n");
    expect(result.stderr).toBe("");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for restart when the daemon build is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.restartFile, "Aimux Restart\n  failures: 0\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["restart"], { NODE_EXIT: "19" });

    expect(result.status).toBe(19);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js restart\n`);
  });

  it("falls back to the Node launcher for non-fast-path commands", () => {
    const fixture = makeFixture();

    const result = fixture.run(["doctor"], { NODE_EXIT: "19" });

    expect(result.status).toBe(19);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js doctor\n`);
  });

  it("leaves daemon startup to the Node supervisor", () => {
    const fixture = makeFixture();

    const result = fixture.run(["daemon", "ensure"], { NODE_EXIT: "31" });

    expect(result.status).toBe(31);
    expect(result.stdout).toBe("");
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js daemon ensure\n`);
  });

  it("rejects release archives without the installed shim contract", () => {
    const root = join(tmpdir(), `aimux-install-contract-${process.pid}-${Date.now()}-${Math.random()}`);
    const packageRoot = join(root, "pkg", "aimux");
    const archive = join(root, "old.tar.gz");
    const installRoot = join(root, "native");
    const binDir = join(root, "bin");
    mkdirSync(join(packageRoot, "scripts"), { recursive: true });
    writeFileSync(join(packageRoot, "VERSION"), "old-local\n");
    const tar = spawnSync("tar", ["-czf", archive, "-C", join(root, "pkg"), "aimux"], { encoding: "utf8" });
    expect(tar.status).toBe(0);

    const result = spawnSync("sh", [installPath, archive], {
      encoding: "utf8",
      env: {
        ...process.env,
        AIMUX_INSTALL_ROOT: installRoot,
        AIMUX_BIN_DIR: binDir,
        AIMUX_SKIP_POST_INSTALL_RESTART: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release archive is missing BUILD_STAMP");
    expect(existsSync(join(installRoot, "old-local"))).toBe(false);
  });
});
