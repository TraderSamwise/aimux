import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  const textRouteFile = join(root, "text-route.txt");
  const authStartFile = join(root, "auth-start.txt");
  const authWaitFile = join(root, "auth-wait.txt");
  const daemonInfoPath = join(home, "daemon", "daemon.json");
  const nodeLog = join(root, "node.log");
  const curlLog = join(root, "curl.log");
  const curlPath = join(bin, "curl");
  const nodePath = join(bin, "node");

  writeFileSync(
    curlPath,
    `#!/usr/bin/env sh
set -eu
url=""
output_file=""
write_status=""
pending_data=0
while [ "$#" -gt 0 ]; do
  if [ "$pending_data" -eq 1 ]; then
    printf '%s\\n' "$1" >> "$CURL_LOG"
    pending_data=0
    shift
    continue
  fi
  case "$1" in
    -o)
      shift
      output_file="$1"
      ;;
    -w)
      shift
      write_status="$1"
      ;;
    --data-urlencode)
      pending_data=1
      ;;
    http://*)
      url="$1"
      ;;
  esac
  shift
done
  case "$url" in
  */core/login-start-text*|*/core/security-unlock-start-text*)
    [ -f "$AUTH_START_FILE" ] || exit 22
    if [ -n "$output_file" ]; then
      cat "$AUTH_START_FILE" > "$output_file"
    else
      cat "$AUTH_START_FILE"
    fi
    [ -n "$write_status" ] && printf '%s' "\${AUTH_START_STATUS:-200}"
    exit 0
    ;;
  */core/login-wait-text*|*/core/security-unlock-wait-text*)
    [ -f "$AUTH_WAIT_FILE" ] || exit 22
    if [ -n "$output_file" ]; then
      cat "$AUTH_WAIT_FILE" > "$output_file"
    else
      cat "$AUTH_WAIT_FILE"
    fi
    [ -n "$write_status" ] && printf '%s' "\${AUTH_WAIT_STATUS:-200}"
    exit 0
    ;;
  */core/daemon-ensure-text*|*/core/daemon-status-text*|*/core/daemon-projects-text*|*/core/host-status-text*|*/core/project-ensure-text*|*/core/projects-list-text*|*/core/remote-status-text*|*/core/remote-enable-text*|*/core/remote-disable-text*|*/core/whoami-text*|*/core/logout-text*|*/core/login-text*|*/core/security-unlock-text*|*/core/lifecycle/spawn-text*|*/core/lifecycle/stop-text*|*/core/lifecycle/kill-text*|*/core/lifecycle/fork-text*|*/core/worktree/list-text*|*/core/worktree/create-text*|*/core/worktree/remove-text*|*/core/worktree/graveyard-text*|*/core/worktree/resurrect-text*|*/core/worktree/delete-graveyard-text*|*/core/graveyard/list-text*|*/core/graveyard/send-text*|*/core/graveyard/resurrect-text*|*/core/graveyard/cleanup-text*)
    [ -f "$TEXT_ROUTE_FILE" ] || exit 22
    if [ -n "$output_file" ]; then
      cat "$TEXT_ROUTE_FILE" > "$output_file"
    else
      cat "$TEXT_ROUTE_FILE"
    fi
    [ -n "$write_status" ] && printf '%s' "\${TEXT_ROUTE_STATUS:-200}"
    exit 0
    ;;
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
    CURL_LOG: curlLog,
    HEALTH_FILE: healthFile,
    RESTART_FILE: restartFile,
    TEXT_ROUTE_FILE: textRouteFile,
    AUTH_START_FILE: authStartFile,
    AUTH_WAIT_FILE: authWaitFile,
    NODE_LOG: nodeLog,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}, options: { cwd?: string } = {}) =>
    spawnSync("sh", [shimPath, ...args], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
      cwd: options.cwd,
    });

  return {
    aimuxRoot,
    authStartFile,
    authWaitFile,
    curlLog,
    daemonInfoPath,
    healthFile,
    restartFile,
    textRouteFile,
    nodeLog,
    root,
    run,
  };
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

  it("serves daemon ensure JSON from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, '{\n  "daemon": {"pid": 321}\n}\n');
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "ensure", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{\n  "daemon": {"pid": 321}\n}\n');
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

  it("falls back to the Node launcher for daemon ensure JSON when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build")}\n`);
    writeFileSync(fixture.textRouteFile, '{\n  "daemon": {"pid": 123}\n}\n');
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 123, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "ensure", "--json"], { NODE_EXIT: "18" });

    expect(result.status).toBe(18);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js daemon ensure --json\n`,
    );
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

  it("serves daemon status from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Daemon pid=321 port=45678\nKnown projects: 1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "status"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Daemon pid=321 port=45678\nKnown projects: 1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves daemon status JSON from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, '{\n  "daemon": {"pid": 321}\n}\n');
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "status", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{\n  "daemon": {"pid": 321}\n}\n');
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves host status from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Service: live\nTmux session: aimux-test\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "status"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Service: live\nTmux session: aimux-test\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves host status JSON from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, '{\n  "projectRoot": "/repo"\n}\n');
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "status", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{\n  "projectRoot": "/repo"\n}\n');
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for host status when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Service: live\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "status"], { NODE_EXIT: "34" });

    expect(result.status).toBe(34);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js host status\n`);
  });

  it("serves daemon project-ensure from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Ensured project service for /repo (pid 88)\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "project-ensure", "--project", "/repo"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Ensured project service for /repo (pid 88)\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("resolves relative daemon project-ensure paths before calling the daemon", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Ensured project service for /repo (pid 88)\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "project-ensure", "--project", "."], {}, { cwd: projectDir });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.curlLog, "utf8")).toContain(`project=${realpathSync(projectDir)}\n`);
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves daemon project-ensure JSON from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, '{\n  "project": {"projectRoot": "/repo"}\n}\n');
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "project-ensure", "--project=/repo", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{\n  "project": {"projectRoot": "/repo"}\n}\n');
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for daemon project-ensure when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Ensured project service for /repo (pid 88)\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "project-ensure", "--project", "/repo"], { NODE_EXIT: "36" });

    expect(result.status).toBe(36);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js daemon project-ensure --project /repo\n`,
    );
  });

  it("falls back to the Node launcher for invalid daemon project-ensure arguments", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Ensured project service for /repo (pid 88)\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "project-ensure", "--project", "/repo", "--dry-run"], { NODE_EXIT: "37" });

    expect(result.status).toBe(37);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js daemon project-ensure --project /repo --dry-run\n`,
    );
  });

  it("serves spawn from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    const worktreeDir = join(fixture.root, "work");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "spawned claude-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(
      ["spawn", "--tool", "claude", "--worktree", "../work", "--no-open", "--json"],
      {},
      { cwd: projectDir },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("spawned claude-1\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain(`project=${realpathSync(projectDir)}\n`);
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("tool=claude\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("worktreePath=../work\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("open=0\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves stop and kill from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    writeFileSync(fixture.textRouteFile, "stopped claude-1\n");
    expect(fixture.run(["stop", "claude-1", "--project", "/repo"]).stdout).toBe("stopped claude-1\n");

    writeFileSync(fixture.textRouteFile, "graveyarded claude-1\n");
    expect(fixture.run(["kill", "claude-1", "--project=/repo", "--json"]).stdout).toBe("graveyarded claude-1\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("sessionId=claude-1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves fork from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "forked codex-2\nthread thread-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run([
      "fork",
      "claude-1",
      "--tool",
      "codex",
      "--instruction",
      "continue the fix",
      "--no-open",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("forked codex-2\nthread thread-1\n");
    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("sourceSessionId=claude-1\n");
    expect(curlLog).toContain("tool=codex\n");
    expect(curlLog).toContain("instruction=continue the fix\n");
    expect(curlLog).toContain("open=0\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("returns lifecycle daemon errors without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Error: session not found\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["stop", "missing"], { TEXT_ROUTE_STATUS: "404" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: session not found\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for lifecycle commands when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "spawned claude-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["spawn", "--tool", "claude"], { NODE_EXIT: "41" });

    expect(result.status).toBe(41);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js spawn --tool claude\n`,
    );
  });

  it("falls back to the Node launcher for invalid lifecycle arguments", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "stopped claude-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["stop"], { NODE_EXIT: "42" });

    expect(result.status).toBe(42);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js stop\n`);
  });

  it("serves worktree commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "removed /repo/wt\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["worktree"], {}, { cwd: projectDir }).stdout).toBe("removed /repo/wt\n");
    expect(fixture.run(["worktree", "list", "--project", "/repo", "--json"]).stdout).toBe("removed /repo/wt\n");
    expect(fixture.run(["worktree", "create", "next", "--project", "/repo", "--json"]).stdout).toBe(
      "removed /repo/wt\n",
    );
    expect(fixture.run(["worktree", "remove", "../wt", "--project=/repo"]).stdout).toBe("removed /repo/wt\n");
    expect(fixture.run(["worktree", "graveyard", "../wt", "--project=/repo"]).stdout).toBe("removed /repo/wt\n");
    expect(fixture.run(["worktree", "resurrect", "../wt", "--project=/repo"]).stdout).toBe("removed /repo/wt\n");
    expect(fixture.run(["worktree", "delete-graveyard", "../wt", "--project=/repo"]).stdout).toBe("removed /repo/wt\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain(`project=${realpathSync(projectDir)}\n`);
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("name=next\n");
    expect(curlLog).toContain("path=../wt\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves graveyard commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "resurrected claude-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["graveyard", "list", "--project", "/repo", "--json"]).stdout).toBe("resurrected claude-1\n");
    expect(fixture.run(["graveyard", "send", "claude-1", "--project=/repo"]).stdout).toBe("resurrected claude-1\n");
    expect(fixture.run(["graveyard", "resurrect", "claude-1", "--project=/repo"]).stdout).toBe(
      "resurrected claude-1\n",
    );
    expect(fixture.run(["graveyard", "cleanup", "--dry-run", "--project=/repo", "--json"]).stdout).toBe(
      "resurrected claude-1\n",
    );

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("sessionId=claude-1\n");
    expect(curlLog).toContain("dryRun=1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for worktree and graveyard commands when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "resurrected claude-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const worktree = fixture.run(["worktree", "create", "next"], { NODE_EXIT: "43" });
    const graveyard = fixture.run(["graveyard", "resurrect", "claude-1"], { NODE_EXIT: "44" });

    expect(worktree.status).toBe(43);
    expect(graveyard.status).toBe(44);
    expect(readFileSync(fixture.nodeLog, "utf8")).toContain(
      `${fixture.aimuxRoot}/dist/launcher-bin.js worktree create next\n`,
    );
    expect(readFileSync(fixture.nodeLog, "utf8")).toContain(
      `${fixture.aimuxRoot}/dist/launcher-bin.js graveyard resurrect claude-1\n`,
    );
  });

  it("serves project list commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "repo  live  /repo\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["daemon", "projects"]).stdout).toBe("repo  live  /repo\n");
    expect(fixture.run(["projects", "list"]).stdout).toBe("repo  live  /repo\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves remote status from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Remote access: enabled\nRelay: wss://relay.example\nConnection: connected\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["remote", "status"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Remote access: enabled\nRelay: wss://relay.example\nConnection: connected\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves remote status JSON from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, '{\n  "loggedIn": true,\n  "relay": {"status": "connected"}\n}\n');
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["remote", "status", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{\n  "loggedIn": true,\n  "relay": {"status": "connected"}\n}\n');
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves remote enable and disable from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    writeFileSync(fixture.textRouteFile, "✓ Remote access enabled (connection: connecting)\n");
    expect(fixture.run(["remote", "enable"]).stdout).toBe("✓ Remote access enabled (connection: connecting)\n");

    writeFileSync(fixture.textRouteFile, "✓ Remote access disabled. Daemon disconnected from relay.\n");
    expect(fixture.run(["remote", "disable"]).stdout).toBe(
      "✓ Remote access disabled. Daemon disconnected from relay.\n",
    );
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("returns remote enable daemon errors without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Not logged in. Run `aimux login` first.\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["remote", "enable"], { TEXT_ROUTE_STATUS: "401" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Not logged in. Run `aimux login` first.\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for remote commands when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Remote access: enabled\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["remote", "status"], { NODE_EXIT: "38" });

    expect(result.status).toBe(38);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js remote status\n`);
  });

  it("serves whoami from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Logged in as user-1\nRelay: wss://relay.example\nRemote access: enabled\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["whoami"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Logged in as user-1\nRelay: wss://relay.example\nRemote access: enabled\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves whoami JSON from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, '{\n  "loggedIn": false\n}\n');
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["whoami", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{\n  "loggedIn": false\n}\n');
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves logout from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "✓ Logged out. Remote access disabled.\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["logout"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("✓ Logged out. Remote access disabled.\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("returns logout daemon errors without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Failed to remove credentials file — check permissions.\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["logout"], { TEXT_ROUTE_STATUS: "500" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Failed to remove credentials file — check permissions.\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for account commands when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Logged in as user-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["whoami"], { NODE_EXIT: "39" });

    expect(result.status).toBe(39);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js whoami\n`);
  });

  it("serves login from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(
      fixture.authStartFile,
      "auth-session: abc123\nOpening your browser to sign in...\n  https://aimux.app/cli-auth\n",
    );
    writeFileSync(fixture.authWaitFile, "\n✓ Logged in as user-1\nRemote access is enabled (connection: connected).\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["login"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "Opening your browser to sign in...\n  https://aimux.app/cli-auth\n\n✓ Logged in as user-1\nRemote access is enabled (connection: connected).\n",
    );
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("returns login daemon errors without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.authStartFile, "auth-session: abc123\nOpening your browser to sign in...\n");
    writeFileSync(fixture.authWaitFile, "Login failed: denied\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["login"], { AUTH_WAIT_STATUS: "500" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("Opening your browser to sign in...\n");
    expect(result.stderr).toBe("Login failed: denied\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves security unlock from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(
      fixture.authStartFile,
      "auth-session: abc123\nOpening your browser to sign in...\n  https://aimux.app/cli-auth\n",
    );
    writeFileSync(
      fixture.authWaitFile,
      "\n✓ Security unlocked for user-1\nRemote access is enabled (connection: connected).\n",
    );
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["security", "unlock"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "Opening your browser to sign in...\n  https://aimux.app/cli-auth\n\n✓ Security unlocked for user-1\nRemote access is enabled (connection: connected).\n",
    );
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for login when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "\n✓ Logged in as user-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["login"], { NODE_EXIT: "40" });

    expect(result.status).toBe(40);
    expect(result.stdout).toBe("");
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js login\n`);
  });

  it("falls back to the Node launcher for security unlock when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "\n✓ Security unlocked for user-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["security", "unlock"], { NODE_EXIT: "40" });

    expect(result.status).toBe(40);
    expect(result.stdout).toBe("");
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js security unlock\n`);
  });

  it("falls back to the Node launcher for text fast paths when the daemon build is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Daemon pid=321 port=45678\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["daemon", "status"], { NODE_EXIT: "33" });

    expect(result.status).toBe(33);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js daemon status\n`);
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
