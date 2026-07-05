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
  const tmuxLog = join(root, "tmux.log");
  const curlLog = join(root, "curl.log");
  const curlPath = join(bin, "curl");
  const nodePath = join(bin, "node");
  const tmuxPath = join(bin, "tmux");

  writeFileSync(
    curlPath,
    `#!/usr/bin/env sh
set -eu
url=""
output_file=""
write_status=""
pending_data=0
fail_on_http=0
while [ "$#" -gt 0 ]; do
  if [ "$pending_data" -eq 1 ]; then
    printf '%s\\n' "$1" >> "$CURL_LOG"
    pending_data=0
    shift
    continue
  fi
  case "$1" in
    -f|-f*|--fail)
      fail_on_http=1
      ;;
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
printf 'URL=%s\n' "$url" >> "$CURL_LOG"
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
	  */core/daemon-ensure-text*|*/core/daemon-status-text*|*/core/daemon-projects-text*|*/core/doctor/versions-text*|*/core/doctor/tmux-text*|*/core/repair-text*|*/core/dashboard-reload-text*|*/core/runtime-restart-text*|*/core/host-status-text*|*/core/host-agent-read-text*|*/core/host-agent-stream-text*|*/core/logs/path-text*|*/core/logs/tail-text*|*/core/logs/clear-text*|*/core/metadata-text*|*/core/project-ensure-text*|*/core/project-serve-text*|*/core/project-stop-text*|*/core/project-kill-text*|*/core/project-restart-text*|*/core/projects-list-text*|*/core/remote-status-text*|*/core/remote-enable-text*|*/core/remote-disable-text*|*/core/whoami-text*|*/core/logout-text*|*/core/login-text*|*/core/security-unlock-text*|*/core/agents/input-text*|*/core/agents/ps-text*|*/core/agents/rename-text*|*/core/agents/migrate-text*|*/core/lifecycle/spawn-text*|*/core/lifecycle/stop-text*|*/core/lifecycle/kill-text*|*/core/lifecycle/fork-text*|*/core/loop/add-text*|*/core/loop/remove-text*|*/core/loop/done-text*|*/core/loop/block-text*|*/core/overseer/start-text*|*/core/overseer/clear-text*|*/core/notifications/list-text*|*/core/notifications/send-text*|*/core/notifications/read-text*|*/core/notifications/clear-text*|*/core/team/show-text*|*/core/team/init-text*|*/core/team/add-text*|*/core/team/remove-text*|*/core/team/default-text*|*/core/worktree/list-text*|*/core/worktree/create-text*|*/core/worktree/remove-text*|*/core/worktree/graveyard-text*|*/core/worktree/resurrect-text*|*/core/worktree/delete-graveyard-text*|*/core/graveyard/list-text*|*/core/graveyard/send-text*|*/core/graveyard/resurrect-text*|*/core/graveyard/cleanup-text*|*/core/threads/list-text*|*/core/thread/list-text*|*/core/thread/show-text*|*/core/thread/open-text*|*/core/thread/send-text*|*/core/thread/mark-seen-text*|*/core/thread/status-text*|*/core/message/send-text*|*/core/handoff/send-text*|*/core/handoff/accept-text*|*/core/handoff/complete-text*|*/core/task/list-text*|*/core/task/show-text*|*/core/task/assign-text*|*/core/task/accept-text*|*/core/task/block-text*|*/core/task/complete-text*|*/core/task/reopen-text*|*/core/review/approve-text*|*/core/review/request-changes-text*)
    [ -f "$TEXT_ROUTE_FILE" ] || exit 22
    [ -n "\${CURL_FORCE_EXIT:-}" ] && exit "$CURL_FORCE_EXIT"
    text_status="\${TEXT_ROUTE_STATUS:-200}"
    case "$text_status" in
      2*) ;;
      *) [ "$fail_on_http" -eq 1 ] && exit 22 ;;
    esac
    if [ -n "$output_file" ]; then
      cat "$TEXT_ROUTE_FILE" > "$output_file"
    else
      cat "$TEXT_ROUTE_FILE"
    fi
    [ -n "$write_status" ] && printf '%s' "$text_status"
    exit 0
    ;;
  */core/restart-text*)
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
  writeFileSync(
    tmuxPath,
    `#!/usr/bin/env sh
set -eu
printf '%s\\n' "$*" >> "$TMUX_LOG"
case "$*" in
  'display-message -p #{client_session}')
    printf '%s\\n' "\${TMUX_CLIENT_SESSION:-aimux-repo-client-feedbeef}"
    ;;
  'display-message -p #{client_tty}')
    printf '%s\\n' "\${TMUX_CLIENT_TTY:-/dev/ttys001}"
    ;;
esac
exit "\${TMUX_EXIT:-0}"
`,
  );
  chmodSync(curlPath, 0o755);
  chmodSync(nodePath, 0o755);
  chmodSync(tmuxPath, 0o755);

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
    TMUX_LOG: tmuxLog,
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
    curlPath,
    nodePath,
    healthFile,
    restartFile,
    textRouteFile,
    tmuxPath,
    tmuxLog,
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

function expectInvalidNoNode(fixture: ReturnType<typeof makeFixture>, args: string[]) {
  const result = fixture.run(args, { NODE_EXIT: "99" });

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("invalid or unsupported arguments");
  expect(existsSync(fixture.nodeLog)).toBe(false);
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

  it("serves restart JSON and daemon restart alias from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.restartFile, '{\n  "summary": {"failures": 0}\n}\n');
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["restart", "--json"]).stdout).toBe('{\n  "summary": {"failures": 0}\n}\n');
    expect(fixture.run(["daemon", "restart", "--json"]).stdout).toBe('{\n  "summary": {"failures": 0}\n}\n');

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/restart-text?json=1");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("passes restart project scope to the daemon from the healthy installed path", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.restartFile, "Aimux Restart\n  projects: 1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["restart", "--project", "."], {}, { cwd: projectDir });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.curlLog, "utf8")).toContain(`project=${realpathSync(projectDir)}\n`);
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

  it("rejects invalid restart arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.restartFile, "Aimux Restart\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["restart", "--open"]);
    expectInvalidNoNode(fixture, ["daemon", "restart", "--project", "/repo"]);
  });

  it("serves doctor and repair commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "doctor ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["doctor", "versions", "--json"]).stdout).toBe("doctor ok\n");
    expect(
      fixture.run(["doctor", "tmux", "--project-root=/repo", "--session", "aimux-repo", "--window-id=@1"]).stdout,
    ).toBe("doctor ok\n");
    expect(fixture.run(["repair", "--project-root=/repo", "--open", "--json"]).stdout).toBe("doctor ok\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/doctor/versions-text?json=1");
    expect(curlLog).toContain("/core/doctor/tmux-text");
    expect(curlLog).toContain("/core/repair-text?json=1");
    expect(curlLog).toContain("projectRoot=/repo\n");
    expect(curlLog).toContain("session=aimux-repo\n");
    expect(curlLog).toContain("windowId=@1\n");
    expect(curlLog).toContain("open=1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for stale doctor and repair daemon health", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "doctor ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["doctor", "tmux", "--project-root=/repo"], { NODE_EXIT: "34" }).status).toBe(34);
    expect(fixture.run(["repair", "--project-root=/repo"], { NODE_EXIT: "35" }).status).toBe(35);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js doctor tmux --project-root=/repo\n` +
        `${fixture.aimuxRoot}/dist/launcher-bin.js repair --project-root=/repo\n`,
    );
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

  it("serves project host management commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "host ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["serve"], {}, { cwd: projectDir }).stdout).toBe("host ok\n");
    expect(fixture.run(["host", "stop"], {}, { cwd: projectDir }).stdout).toBe("host ok\n");
    expect(fixture.run(["host", "kill"], {}, { cwd: projectDir }).stdout).toBe("host ok\n");
    expect(fixture.run(["host", "restart"], {}, { cwd: projectDir }).stdout).toBe("host ok\n");
    expect(fixture.run(["host", "restart", "--serve"], {}, { cwd: projectDir }).stdout).toBe("host ok\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/project-serve-text");
    expect(curlLog).toContain("/core/project-stop-text");
    expect(curlLog).toContain("/core/project-kill-text");
    expect(curlLog).toContain("/core/project-restart-text");
    expect(curlLog).toContain(`project=${realpathSync(projectDir)}\n`);
    expect(curlLog).toContain("serve=1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves dashboard reload and runtime restart from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    writeFileSync(fixture.textRouteFile, "Reloaded dashboard for aimux-repo\n");
    expect(fixture.run(["dashboard-reload"], {}, { cwd: projectDir }).stdout).toBe(
      "Reloaded dashboard for aimux-repo\n",
    );

    writeFileSync(fixture.textRouteFile, '{\n  "ok": true\n}\n');
    expect(fixture.run(["restart-runtime", "--project-root", ".", "--json"], {}, { cwd: projectDir }).stdout).toBe(
      '{\n  "ok": true\n}\n',
    );

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/dashboard-reload-text");
    expect(curlLog).toContain("/core/runtime-restart-text?json=1");
    expect(curlLog).toContain(`projectRoot=${realpathSync(projectDir)}\n`);
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("opens dashboard reload targets from the caller tmux client without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Reloaded dashboard for aimux-repo\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["dashboard-reload", "--open"], { TMUX: "/tmp/tmux-client" }, { cwd: projectDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Reloaded dashboard for aimux-repo\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("/core/dashboard-reload-text");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("open=1\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("currentClientSession=aimux-repo-client-feedbeef\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("clientTty=/dev/ttys001\n");
    expect(readFileSync(fixture.tmuxLog, "utf8")).toBe(
      "display-message -p #{client_session}\ndisplay-message -p #{client_tty}\n",
    );
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("attaches outside-tmux dashboard reload targets without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(
      fixture.textRouteFile,
      JSON.stringify(
        {
          projectRoot: realpathSync(projectDir),
          dashboardSessionName: "aimux-repo",
          dashboardTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
        },
        null,
        2,
      ),
    );
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["dashboard-reload", "--open"], {}, { cwd: projectDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Reloaded dashboard for aimux-repo\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("/core/dashboard-reload-text?json=1");
    expect(readFileSync(fixture.tmuxLog, "utf8")).toBe("attach-session -t aimux-repo:0\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for stale dashboard reload and runtime restart daemon health", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "dashboard ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["dashboard-reload"], { NODE_EXIT: "46" }).status).toBe(46);
    expect(fixture.run(["restart-runtime", "--project-root", "/repo"], { NODE_EXIT: "47" }).status).toBe(47);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js dashboard-reload\n` +
        `${fixture.aimuxRoot}/dist/launcher-bin.js restart-runtime --project-root /repo\n`,
    );
  });

  it("rejects invalid dashboard reload and runtime restart arguments without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "dashboard ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["dashboard-reload", "--json"]);
    expectInvalidNoNode(fixture, ["restart-runtime", "--project-root"]);
    expectInvalidNoNode(fixture, ["restart-runtime", "--bad"]);
    const openJson = fixture.run(["restart-runtime", "--open", "--json"], { NODE_EXIT: "99" });
    expect(openJson.status).toBe(1);
    expect(openJson.stdout).toBe("");
    expect(openJson.stderr).toContain("restart-runtime --open cannot be combined with --json");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("opens host restart targets from the caller shell without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Restarted project service for aimux-repo\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "restart", "--open"], { TMUX: "/tmp/tmux-client" }, { cwd: projectDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Restarted project service for aimux-repo\n");
    expect(result.stderr).toBe("");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("/core/project-restart-text");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("open=1\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("currentClientSession=aimux-repo-client-feedbeef\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("clientTty=/dev/ttys001\n");
    expect(readFileSync(fixture.tmuxLog, "utf8")).toBe(
      "display-message -p #{client_session}\ndisplay-message -p #{client_tty}\n",
    );
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("reports outside-tmux dashboard attach failures after host restart without falling through to Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(
      fixture.textRouteFile,
      JSON.stringify(
        {
          projectRoot: realpathSync(projectDir),
          project: { projectId: "repo", projectRoot: realpathSync(projectDir), pid: 89 },
          dashboardSessionName: "aimux-repo",
          dashboardTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
        },
        null,
        2,
      ),
    );
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "restart", "--open"], { TMUX_EXIT: "42" }, { cwd: projectDir });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("Restarted project service for aimux-repo\n");
    expect(result.stderr).toContain("failed to open dashboard aimux-repo:0");
    expect(result.stderr).not.toContain("invalid or unsupported arguments");
    expect(readFileSync(fixture.tmuxLog, "utf8")).toBe("attach-session -t aimux-repo:0\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("reports missing tmux after outside-tmux host restart without falling through to Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(
      fixture.textRouteFile,
      JSON.stringify(
        {
          projectRoot: realpathSync(projectDir),
          project: { projectId: "repo", projectRoot: realpathSync(projectDir), pid: 89 },
          dashboardSessionName: "aimux-repo",
          dashboardTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 0, windowName: "dashboard" },
        },
        null,
        2,
      ),
    );
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const noTmuxBin = join(fixture.root, "bin-no-tmux");
    mkdirSync(noTmuxBin, { recursive: true });
    writeFileSync(join(noTmuxBin, "curl"), `#!/usr/bin/env sh\nexec "${fixture.curlPath}" "$@"\n`);
    writeFileSync(join(noTmuxBin, "node"), `#!/usr/bin/env sh\nexec "${fixture.nodePath}" "$@"\n`);
    chmodSync(join(noTmuxBin, "curl"), 0o755);
    chmodSync(join(noTmuxBin, "node"), 0o755);

    const result = fixture.run(
      ["host", "restart", "--open"],
      { PATH: `${noTmuxBin}:/usr/bin:/bin` },
      { cwd: projectDir },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("Restarted project service for aimux-repo\n");
    expect(result.stderr).toContain("tmux is not available to open dashboard aimux-repo:0");
    expect(result.stderr).not.toContain("invalid or unsupported arguments");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("reports missing dashboard targets after host restart open without falling through to Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(
      fixture.textRouteFile,
      JSON.stringify(
        {
          projectRoot: realpathSync(projectDir),
          project: { projectId: "repo", projectRoot: realpathSync(projectDir), pid: 89 },
        },
        null,
        2,
      ),
    );
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "restart", "--open"], {}, { cwd: projectDir });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`Restarted project service for ${realpathSync(projectDir)}\n`);
    expect(result.stderr).toContain("no dashboard target was available to open");
    expect(result.stderr).not.toContain("invalid or unsupported arguments");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("reports missing dashboard targets for host restart serve open without falling through to Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(
      fixture.textRouteFile,
      JSON.stringify(
        {
          projectRoot: realpathSync(projectDir),
          project: { projectId: "repo", projectRoot: realpathSync(projectDir), pid: 89 },
        },
        null,
        2,
      ),
    );
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "restart", "--serve", "--open"], { TMUX: "/tmp/tmux-1" }, { cwd: projectDir });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`Restarted project service for ${realpathSync(projectDir)}\n`);
    expect(result.stderr).toContain("no dashboard target was available to open");
    expect(result.stderr).not.toContain("invalid or unsupported arguments");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("serve=1\n");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("/core/project-restart-text?json=1");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for stale project host management daemon health", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "host ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["serve"], { NODE_EXIT: "44" }).status).toBe(44);
    expect(fixture.run(["host", "restart", "--serve"], { NODE_EXIT: "45" }).status).toBe(45);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js serve\n` +
        `${fixture.aimuxRoot}/dist/launcher-bin.js host restart --serve\n`,
    );
  });

  it("rejects invalid project host management arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "host ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["serve", "--json"]);
    expectInvalidNoNode(fixture, ["host", "stop", "--serve"]);
    expectInvalidNoNode(fixture, ["host", "stop", "--open"]);
  });

  it("serves logs commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "logs ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["logs", "path"], {}, { cwd: projectDir }).stdout).toBe("logs ok\n");
    expect(fixture.run(["logs", "tail", "--project", "/repo", "-n", "100"]).stdout).toBe("logs ok\n");
    expect(fixture.run(["logs", "path", "--daemon"]).stdout).toBe("logs ok\n");
    expect(fixture.run(["logs", "clear", "--daemon"]).stdout).toBe("logs ok\n");
    expect(fixture.run(["logs", "path", "--project", "-foo"], {}, { cwd: projectDir }).stdout).toBe("logs ok\n");
    expect(fixture.run(["logs", "tail", "-n", "-5"], {}, { cwd: projectDir }).stdout).toBe("logs ok\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/logs/path-text");
    expect(curlLog).toContain("/core/logs/tail-text");
    expect(curlLog).toContain("/core/logs/clear-text");
    expect(curlLog).toContain(`project=${realpathSync(projectDir)}\n`);
    expect(curlLog).toContain(`project=${realpathSync(projectDir)}/-foo\n`);
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("lines=100\n");
    expect(curlLog).toContain("lines=-5\n");
    expect(curlLog).toContain("daemon=1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it.each([
    { args: ["logs", "path", "--project", "/repo"], exit: "37" },
    { args: ["logs", "tail", "--project", "/repo", "--lines", "50"], exit: "38" },
    { args: ["logs", "clear", "--daemon"], exit: "39" },
  ])("falls back to the Node launcher for stale daemon health: $args", ({ args, exit }) => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "logs ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(args, { NODE_EXIT: exit });

    expect(result.status).toBe(Number(exit));
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js ${args.join(" ")}\n`);
  });

  it("returns logs daemon errors without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "No log entries at /tmp/aimux.log\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["logs", "tail", "--daemon"], { TEXT_ROUTE_STATUS: "404" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("No log entries at /tmp/aimux.log\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("rejects invalid logs arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "logs ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["logs", "tail", "--project"]);
    expectInvalidNoNode(fixture, ["logs", "path", "--lines", "10"]);
    expectInvalidNoNode(fixture, ["logs", "clear", "--json"]);
  });

  it("serves metadata commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["metadata", "set-status", "claude-1", "Ready", "--tone", "success"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/metadata-text");
    expect(curlLog).toContain("project=");
    expect(curlLog).toContain("arg=metadata\n");
    expect(curlLog).toContain("arg=set-status\n");
    expect(curlLog).toContain("arg=claude-1\n");
    expect(curlLog).toContain("arg=Ready\n");
    expect(curlLog).toContain("arg=--tone\n");
    expect(curlLog).toContain("arg=success\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for metadata when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["metadata", "endpoint"], { NODE_EXIT: "41" });

    expect(result.status).toBe(41);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js metadata endpoint\n`);
  });

  it("falls through to Commander help for metadata help", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["metadata", "set-status", "--help"], { NODE_EXIT: "0" });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js metadata set-status --help\n`,
    );
    expect(existsSync(fixture.curlLog)).toBe(false);
  });

  it("falls through to Commander help for bare metadata", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["metadata"], { NODE_EXIT: "0" });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(`${fixture.aimuxRoot}/dist/launcher-bin.js metadata\n`);
    expect(existsSync(fixture.curlLog)).toBe(false);
  });

  it("falls through to Commander help for metadata help subcommands", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["metadata", "help", "set-status"], { NODE_EXIT: "0" });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js metadata help set-status\n`,
    );
    expect(existsSync(fixture.curlLog)).toBe(false);
  });

  it("returns metadata daemon errors without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "metadata set-status requires <session> and <text>\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["metadata", "set-status"], { TEXT_ROUTE_STATUS: "400" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("metadata set-status requires <session> and <text>\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves host agent-read from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "pane output\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "agent-read", "claude-1", "--project", "/repo", "--start-line", "-80"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("pane output\n");
    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/host-agent-read-text");
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("sessionId=claude-1\n");
    expect(curlLog).toContain("startLine=-80\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for host agent-read when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "pane output\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "agent-read", "claude-1", "--project", "/repo"], { NODE_EXIT: "35" });

    expect(result.status).toBe(35);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js host agent-read claude-1 --project /repo\n`,
    );
  });

  it("serves host agent-stream from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "streamed output\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run([
      "host",
      "agent-stream",
      "claude-1",
      "--project",
      "/repo",
      "--start-line",
      "-80",
      "--interval-ms",
      "250",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("streamed output\n");
    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/host-agent-stream-text");
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("sessionId=claude-1\n");
    expect(curlLog).toContain("startLine=-80\n");
    expect(curlLog).toContain("intervalMs=250\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for host agent-stream when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "streamed output\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "agent-stream", "claude-1", "--project", "/repo"], { NODE_EXIT: "36" });

    expect(result.status).toBe(36);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js host agent-stream claude-1 --project /repo\n`,
    );
  });

  it("returns nonzero for host agent-stream daemon errors without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Error: --start-line must be an integer\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "agent-stream", "claude-1", "--project", "/repo", "--start-line", "10px"], {
      TEXT_ROUTE_STATUS: "400",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("/core/host-agent-stream-text");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("does not fall back to Node after host agent-stream curl failures", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "partial stream\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["host", "agent-stream", "claude-1", "--project", "/repo"], {
      CURL_FORCE_EXIT: "56",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("/core/host-agent-stream-text");
    expect(existsSync(fixture.nodeLog)).toBe(false);
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

  it("rejects invalid daemon command arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Ensured project service for /repo (pid 88)\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["daemon", "project-ensure", "--project", "/repo", "--dry-run"]);
    expectInvalidNoNode(fixture, ["daemon", "status", "--verbose"]);
    expectInvalidNoNode(fixture, ["projects", "list", "--verbose"]);
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

  it("serves agent utility commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    writeFileSync(fixture.textRouteFile, "delivered to claude-1\n");
    expect(fixture.run(["input", "claude-1", "hello", "--project", projectDir], {}, { cwd: projectDir }).stdout).toBe(
      "delivered to claude-1\n",
    );
    expect(fixture.run(["input", "claude-1", "--", "--flag"], {}, { cwd: projectDir }).stdout).toBe(
      "delivered to claude-1\n",
    );

    writeFileSync(fixture.textRouteFile, "claude-1  [claude]  ready\n");
    expect(fixture.run(["ps", "--project", projectDir, "--json"]).stdout).toBe("claude-1  [claude]  ready\n");

    writeFileSync(fixture.textRouteFile, "renamed claude-1 -> reviewer\n");
    expect(fixture.run(["rename", "claude-1", "--label", "reviewer", "--project=/repo"]).stdout).toBe(
      "renamed claude-1 -> reviewer\n",
    );
    writeFileSync(fixture.textRouteFile, "renamed claude-1 ->\n");
    expect(fixture.run(["rename", "claude-1", "--label="], {}, { cwd: projectDir }).stdout).toBe(
      "renamed claude-1 ->\n",
    );

    writeFileSync(fixture.textRouteFile, "migrated claude-1 -> feature\n");
    expect(fixture.run(["migrate", "claude-1", "--worktree", "feature"], {}, { cwd: projectDir }).stdout).toBe(
      "migrated claude-1 -> feature\n",
    );

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/agents/input-text");
    expect(curlLog).toContain("/core/agents/ps-text?json=1");
    expect(curlLog).toContain("/core/agents/rename-text");
    expect(curlLog).toContain("/core/agents/migrate-text");
    expect(curlLog).toContain("sessionId=claude-1\n");
    expect(curlLog).toContain("text=hello\n");
    expect(curlLog).toContain("text=--flag\n");
    expect(curlLog).toContain("label=reviewer\n");
    expect(curlLog).toContain("label=\n");
    expect(curlLog).toContain("worktreePath=feature\n");
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

  it("falls back to the Node launcher for agent utility commands when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "delivered to claude-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["rename", "claude-1", "--label", "reviewer"], { NODE_EXIT: "44" });

    expect(result.status).toBe(44);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js rename claude-1 --label reviewer\n`,
    );
  });

  it("rejects invalid lifecycle arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "stopped claude-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["stop", "--bad"]);
    expectInvalidNoNode(fixture, ["spawn", "--tool"]);
  });

  it("rejects invalid agent utility arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "agent ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["input", "claude-1"]);
    expectInvalidNoNode(fixture, ["input", "claude-1", "--flag"]);
    expectInvalidNoNode(fixture, ["ps", "--bad"]);
    expectInvalidNoNode(fixture, ["rename", "claude-1", "--label"]);
    expectInvalidNoNode(fixture, ["migrate", "claude-1", "--worktree"]);
  });

  it("keeps bare project-runtime stop on the bootstrap launcher path", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "stopped claude-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["stop"], { NODE_EXIT: "42" }).status).toBe(42);
    expect(fixture.run(["stop", "--project", "/repo", "--json"], { NODE_EXIT: "43" }).status).toBe(43);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js stop\n` +
        `${fixture.aimuxRoot}/dist/launcher-bin.js stop --project /repo --json\n`,
    );
  });

  it("serves loop commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "loop ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["loop", "add", "claude-1", "--goal", "keep going", "--project=/repo"]).stdout).toBe(
      "loop ok\n",
    );
    expect(fixture.run(["loop", "remove", "claude-1", "--project", "/repo"]).stdout).toBe("loop ok\n");
    expect(
      fixture.run(["loop", "done", "--reason", "done", "--project", "/repo"], { AIMUX_SESSION_ID: "claude-env" })
        .stdout,
    ).toBe("loop ok\n");
    expect(fixture.run(["loop", "block", "--session=claude-1", "--reason=blocked", "--project=/repo"]).stdout).toBe(
      "loop ok\n",
    );

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/loop/add-text");
    expect(curlLog).toContain("/core/loop/remove-text");
    expect(curlLog).toContain("/core/loop/done-text");
    expect(curlLog).toContain("/core/loop/block-text");
    expect(curlLog).toContain("sessionId=claude-env\n");
    expect(curlLog).toContain("goal=keep going\n");
    expect(curlLog).toContain("reason=blocked\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves overseer commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "overseer ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(
      fixture.run(["overseer", "start", "--tool", "claude", "--worktree", "feature", "--no-open", "--json"]).stdout,
    ).toBe("overseer ok\n");
    expect(fixture.run(["overseer", "clear", "claude-1", "--project=/repo"]).stdout).toBe("overseer ok\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/overseer/start-text?json=1");
    expect(curlLog).toContain("/core/overseer/clear-text");
    expect(curlLog).toContain("tool=claude\n");
    expect(curlLog).toContain("worktreePath=feature\n");
    expect(curlLog).toContain("open=0\n");
    expect(curlLog).toContain("sessionId=claude-1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves team commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "team ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["team", "show", "--project=/repo"]).stdout).toBe("team ok\n");
    expect(fixture.run(["team", "init", "--project", "/repo", "--json"]).stdout).toBe("team ok\n");
    expect(
      fixture.run([
        "team",
        "add",
        "planner",
        "-d",
        "Plans work",
        "--reviewed-by",
        "reviewer",
        "--can-edit",
        "--project=/repo",
        "--json",
      ]).stdout,
    ).toBe("team ok\n");
    expect(fixture.run(["team", "default", "--project=/repo", "planner"]).stdout).toBe("team ok\n");
    expect(fixture.run(["team", "remove", "--json", "--project=/repo", "planner"]).stdout).toBe("team ok\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/team/show-text");
    expect(curlLog).toContain("/core/team/init-text?json=1");
    expect(curlLog).toContain("/core/team/add-text?json=1");
    expect(curlLog).toContain("/core/team/default-text");
    expect(curlLog).toContain("/core/team/remove-text?json=1");
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("role=planner\n");
    expect(curlLog).toContain("description=Plans work\n");
    expect(curlLog).toContain("reviewedBy=reviewer\n");
    expect(curlLog).toContain("canEdit=1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("serves notification commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "notifications ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(
      fixture.run([
        "notify",
        "--project=/repo",
        "--title",
        "Heads up",
        "--subtitle=Agent",
        "--body",
        "Ready",
        "--session=claude-1",
        "--kind=attention",
        "--json",
      ]).stdout,
    ).toBe("notifications ok\n");
    expect(fixture.run(["list-notifications", "--project=/repo", "--unread", "--session", "claude-1"]).stdout).toBe(
      "notifications ok\n",
    );
    expect(
      fixture.run([
        "read-notifications",
        "--project",
        "/repo",
        "--id=note-1",
        "--ids",
        "note-2,note-3",
        "--session=claude-1",
        "--json",
      ]).stdout,
    ).toBe("notifications ok\n");
    expect(fixture.run(["clear-notifications", "--project=/repo", "--ids=note-4,note-5"]).stdout).toBe(
      "notifications ok\n",
    );

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain("/core/notifications/send-text?json=1");
    expect(curlLog).toContain("/core/notifications/list-text");
    expect(curlLog).toContain("/core/notifications/read-text?json=1");
    expect(curlLog).toContain("/core/notifications/clear-text");
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("title=Heads up\n");
    expect(curlLog).toContain("subtitle=Agent\n");
    expect(curlLog).toContain("body=Ready\n");
    expect(curlLog).toContain("id=note-1\n");
    expect(curlLog).toContain("ids=note-2,note-3\n");
    expect(curlLog).toContain("ids=note-4,note-5\n");
    expect(curlLog).toContain("sessionId=claude-1\n");
    expect(curlLog).toContain("kind=attention\n");
    expect(curlLog).toContain("unread=1\n");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("falls back to the Node launcher for stale notification daemon health", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "notifications ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(
      fixture.run(
        ["read-notifications", "--project=/repo", "--id=note-1", "--ids", "note-2,note-3", "--session=claude-1"],
        { NODE_EXIT: "46" },
      ).status,
    ).toBe(46);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js read-notifications --project=/repo --id=note-1 --ids note-2,note-3 --session=claude-1\n`,
    );
  });

  it("falls back to the Node launcher for stale loop and overseer daemon health", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "loop ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["loop", "add", "claude-1"], { NODE_EXIT: "43" }).status).toBe(43);
    expect(fixture.run(["overseer", "clear", "claude-1"], { NODE_EXIT: "44" }).status).toBe(44);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js loop add claude-1\n` +
        `${fixture.aimuxRoot}/dist/launcher-bin.js overseer clear claude-1\n`,
    );
  });

  it("falls back to the Node launcher for stale team daemon health with matching flags", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "team ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["team", "show", "--project=/repo", "--json"], { NODE_EXIT: "43" }).status).toBe(43);
    expect(
      fixture.run(
        [
          "team",
          "add",
          "--project=/repo",
          "--json",
          "-d",
          "Plans work",
          "planner",
          "--reviewed-by",
          "reviewer",
          "--can-edit",
        ],
        { NODE_EXIT: "44" },
      ).status,
    ).toBe(44);
    expect(readFileSync(fixture.nodeLog, "utf8")).toBe(
      `${fixture.aimuxRoot}/dist/launcher-bin.js team show --project=/repo --json\n` +
        `${fixture.aimuxRoot}/dist/launcher-bin.js team add --project=/repo --json -d Plans work planner --reviewed-by reviewer --can-edit\n`,
    );
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("/health");
  });

  it("rejects invalid loop and overseer arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "loop ok\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["loop", "done"]);
    expectInvalidNoNode(fixture, ["overseer", "clear"]);
    expectInvalidNoNode(fixture, ["loop", "remove", "claude-1", "--goal", "invalid"]);
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
    expect(fixture.run(["worktree", "remove", "../wt", "--project=/repo"], {}, { cwd: projectDir }).stdout).toBe(
      "removed /repo/wt\n",
    );
    expect(fixture.run(["worktree", "graveyard", "../wt", "--project=/repo"], {}, { cwd: projectDir }).stdout).toBe(
      "removed /repo/wt\n",
    );
    expect(fixture.run(["worktree", "resurrect", "../wt", "--project=/repo"], {}, { cwd: projectDir }).stdout).toBe(
      "removed /repo/wt\n",
    );
    expect(
      fixture.run(["worktree", "delete-graveyard", "../wt", "--project=/repo"], {}, { cwd: projectDir }).stdout,
    ).toBe("removed /repo/wt\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain(`project=${realpathSync(projectDir)}\n`);
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("name=next\n");
    expect(curlLog).toContain(`path=${realpathSync(projectDir)}/../wt\n`);
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("prints daemon errors for worktree list without falling back to Node", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "Error: project service unavailable\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const result = fixture.run(["worktree", "list", "--project", "/repo"], { TEXT_ROUTE_STATUS: "503" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: project service unavailable\n");
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

  it("serves thread and message commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "thread thread-1\nstatus waiting\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(fixture.run(["threads", "--session", "claude-1", "--json"], {}, { cwd: projectDir }).stdout).toBe(
      "thread thread-1\nstatus waiting\n",
    );
    expect(fixture.run(["thread", "list", "--project", "/repo"]).stdout).toBe("thread thread-1\nstatus waiting\n");
    expect(fixture.run(["thread", "show", "thread-1", "--project=/repo", "--json"]).stdout).toBe(
      "thread thread-1\nstatus waiting\n",
    );
    expect(
      fixture.run([
        "thread",
        "open",
        "--title",
        "Hello",
        "--from",
        "user",
        "--participants",
        "claude-1,codex-1",
        "--project=/repo",
        "--json",
      ]).stdout,
    ).toBe("thread thread-1\nstatus waiting\n");
    expect(
      fixture.run([
        "thread",
        "send",
        "thread-1",
        "ping please",
        "--from",
        "user",
        "--to=claude-1",
        "--project=/repo",
        "--json",
      ]).stdout,
    ).toBe("thread thread-1\nstatus waiting\n");
    expect(
      fixture.run(["thread", "mark-seen", "thread-1", "--session", "user", "--project=/repo", "--json"]).stdout,
    ).toBe("thread thread-1\nstatus waiting\n");
    expect(
      fixture.run([
        "thread",
        "status",
        "thread-1",
        "--status",
        "waiting",
        "--owner=user",
        "--waiting-on=claude-1",
        "--project=/repo",
        "--json",
      ]).stdout,
    ).toBe("thread thread-1\nstatus waiting\n");
    expect(
      fixture.run([
        "message",
        "send",
        "please help",
        "--to=claude-1",
        "--assignee=coder",
        "--tool=claude",
        "--worktree=feature",
        "--title=Ask",
        "--project=/repo",
        "--json",
      ]).stdout,
    ).toBe("thread thread-1\nstatus waiting\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain(`project=${realpathSync(projectDir)}\n`);
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("session=claude-1\n");
    expect(curlLog).toContain("threadId=thread-1\n");
    expect(curlLog).toContain("participants=claude-1,codex-1\n");
    expect(curlLog).toContain("body=ping please\n");
    expect(curlLog).toContain("body=please help\n");
    expect(curlLog).toContain("waitingOn=claude-1\n");
    expect(curlLog).toContain("/core/thread/open-text?json=1");
    expect(curlLog).toContain("/core/thread/send-text?json=1");
    expect(curlLog).toContain("/core/thread/mark-seen-text?json=1");
    expect(curlLog).toContain("/core/thread/status-text?json=1");
    expect(curlLog).toContain("/core/message/send-text?json=1");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("rejects invalid thread and message fast-path arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "thread thread-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["thread", "open", "--title", "--from", "user", "--participants", "claude-1"]);
    expectInvalidNoNode(fixture, ["message", "send", "body", "--to="]);
  });

  it("falls back to the Node launcher for thread and message commands when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "thread thread-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const thread = fixture.run(["thread", "send", "thread-1", "body", "--from", "user"], { NODE_EXIT: "45" });
    const message = fixture.run(["message", "send", "body", "--to", "claude-1"], { NODE_EXIT: "46" });

    expect(thread.status).toBe(45);
    expect(message.status).toBe(46);
    expect(readFileSync(fixture.nodeLog, "utf8")).toContain(
      `${fixture.aimuxRoot}/dist/launcher-bin.js thread send thread-1 body --from user\n`,
    );
    expect(readFileSync(fixture.nodeLog, "utf8")).toContain(
      `${fixture.aimuxRoot}/dist/launcher-bin.js message send body --to claude-1\n`,
    );
  });

  it("serves workflow commands from a matching daemon without launching Node", () => {
    const fixture = makeFixture();
    const projectDir = join(fixture.root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "task task-1\nthread thread-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expect(
      fixture.run(["task", "list", "--session", "claude-1", "--status=todo", "--json"], {}, { cwd: projectDir }).stdout,
    ).toBe("task task-1\nthread thread-1\n");
    expect(fixture.run(["task", "show", "task-1", "--project", "/repo", "--json"]).stdout).toBe(
      "task task-1\nthread thread-1\n",
    );
    expect(
      fixture.run([
        "task",
        "assign",
        "Ship it",
        "--from=user",
        "--to=claude-1",
        "--assignee=coder",
        "--tool=claude",
        "--prompt=Implement",
        "--type=review",
        "--diff",
        "--- before\n+++ after",
        "--worktree=feature",
        "--project=/repo",
        "--json",
      ]).stdout,
    ).toBe("task task-1\nthread thread-1\n");
    expect(fixture.run(["task", "accept", "task-1", "--from", "claude-1", "--body=ok", "--project=/repo"]).stdout).toBe(
      "task task-1\nthread thread-1\n",
    );
    expect(
      fixture.run(["task", "block", "task-1", "--from=claude-1", "--body", "blocked", "--project=/repo"]).stdout,
    ).toBe("task task-1\nthread thread-1\n");
    expect(
      fixture.run(["task", "complete", "task-1", "--from=claude-1", "--body=done", "--project=/repo"]).stdout,
    ).toBe("task task-1\nthread thread-1\n");
    expect(fixture.run(["task", "reopen", "task-1", "--from=claude-1", "--body=again", "--project=/repo"]).stdout).toBe(
      "task task-1\nthread thread-1\n",
    );
    expect(
      fixture.run([
        "handoff",
        "send",
        "Please take over",
        "--from=user",
        "--to=claude-1",
        "--assignee=coder",
        "--tool=claude",
        "--worktree=feature",
        "--title=Takeover",
        "--project=/repo",
        "--json",
      ]).stdout,
    ).toBe("task task-1\nthread thread-1\n");
    expect(
      fixture.run(["handoff", "accept", "thread-1", "--from=claude-1", "--body=ok", "--project=/repo"]).stdout,
    ).toBe("task task-1\nthread thread-1\n");
    expect(
      fixture.run(["handoff", "complete", "thread-1", "--from=claude-1", "--body=done", "--project=/repo"]).stdout,
    ).toBe("task task-1\nthread thread-1\n");
    expect(fixture.run(["review", "approve", "task-1", "--from=reviewer", "--body=ok", "--project=/repo"]).stdout).toBe(
      "task task-1\nthread thread-1\n",
    );
    expect(
      fixture.run(["review", "request-changes", "task-1", "--from=reviewer", "--body=fix", "--project=/repo", "--json"])
        .stdout,
    ).toBe("task task-1\nthread thread-1\n");

    const curlLog = readFileSync(fixture.curlLog, "utf8");
    expect(curlLog).toContain(`project=${realpathSync(projectDir)}\n`);
    expect(curlLog).toContain("project=/repo\n");
    expect(curlLog).toContain("session=claude-1\n");
    expect(curlLog).toContain("status=todo\n");
    expect(curlLog).toContain("taskId=task-1\n");
    expect(curlLog).toContain("threadId=thread-1\n");
    expect(curlLog).toContain("description=Ship it\n");
    expect(curlLog).toContain("diff=--- before\n+++ after\n");
    expect(curlLog).toContain("body=Please take over\n");
    expect(curlLog).toContain("/core/task/list-text?json=1");
    expect(curlLog).toContain("/core/task/assign-text?json=1");
    expect(curlLog).toContain("/core/handoff/send-text?json=1");
    expect(curlLog).toContain("/core/review/request-changes-text?json=1");
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it("rejects invalid workflow fast-path arguments without launching Node when the daemon is healthy", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("build-1", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "task task-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    expectInvalidNoNode(fixture, ["task", "assign", "Ship", "--to="]);
    expectInvalidNoNode(fixture, ["handoff", "accept", "thread-1", "--body"]);
    expectInvalidNoNode(fixture, ["review", "approve", "task-1", "--from", "--body=ok"]);
  });

  it("falls back to the Node launcher for workflow commands when daemon health is stale", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.healthFile, `${health("old-build", 321)}\n`);
    writeFileSync(fixture.textRouteFile, "task task-1\n");
    writeFileSync(fixture.daemonInfoPath, `${JSON.stringify({ pid: 321, port: 45678 })}\n`);

    const task = fixture.run(["task", "complete", "task-1", "--from", "claude-1"], { NODE_EXIT: "52" });
    const handoff = fixture.run(["handoff", "send", "body", "--to", "claude-1"], { NODE_EXIT: "53" });
    const review = fixture.run(["review", "request-changes", "task-1", "--body", "fix"], { NODE_EXIT: "54" });

    expect(task.status).toBe(52);
    expect(handoff.status).toBe(53);
    expect(review.status).toBe(54);
    const nodeLog = readFileSync(fixture.nodeLog, "utf8");
    expect(nodeLog).toContain(`${fixture.aimuxRoot}/dist/launcher-bin.js task complete task-1 --from claude-1\n`);
    expect(nodeLog).toContain(`${fixture.aimuxRoot}/dist/launcher-bin.js handoff send body --to claude-1\n`);
    expect(nodeLog).toContain(`${fixture.aimuxRoot}/dist/launcher-bin.js review request-changes task-1 --body fix\n`);
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
