#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const AUDITED_LOCAL_PACKAGE_IDENTITIES = [
  "path#aimux@0.1.0",
  "registry+https://github.com/rust-lang/crates.io-index#anstream@1.0.0",
  "registry+https://github.com/rust-lang/crates.io-index#anstyle-parse@1.0.0",
  "registry+https://github.com/rust-lang/crates.io-index#anstyle-query@1.1.5",
  "registry+https://github.com/rust-lang/crates.io-index#anstyle-wincon@3.0.11",
  "registry+https://github.com/rust-lang/crates.io-index#anstyle@1.0.14",
  "registry+https://github.com/rust-lang/crates.io-index#anyhow@1.0.104",
  "registry+https://github.com/rust-lang/crates.io-index#block-buffer@0.10.4",
  "registry+https://github.com/rust-lang/crates.io-index#bytes@1.12.1",
  "registry+https://github.com/rust-lang/crates.io-index#cfg-if@1.0.4",
  "registry+https://github.com/rust-lang/crates.io-index#clap@4.6.6",
  "registry+https://github.com/rust-lang/crates.io-index#clap_builder@4.6.6",
  "registry+https://github.com/rust-lang/crates.io-index#clap_derive@4.6.4",
  "registry+https://github.com/rust-lang/crates.io-index#clap_lex@1.1.0",
  "registry+https://github.com/rust-lang/crates.io-index#colorchoice@1.0.5",
  "registry+https://github.com/rust-lang/crates.io-index#cpufeatures@0.2.17",
  "registry+https://github.com/rust-lang/crates.io-index#crypto-common@0.1.7",
  "registry+https://github.com/rust-lang/crates.io-index#deranged@0.5.8",
  "registry+https://github.com/rust-lang/crates.io-index#digest@0.10.7",
  "registry+https://github.com/rust-lang/crates.io-index#equivalent@1.0.2",
  "registry+https://github.com/rust-lang/crates.io-index#errno@0.3.14",
  "registry+https://github.com/rust-lang/crates.io-index#generic-array@0.14.7",
  "registry+https://github.com/rust-lang/crates.io-index#hashbrown@0.17.1",
  "registry+https://github.com/rust-lang/crates.io-index#heck@0.5.0",
  "registry+https://github.com/rust-lang/crates.io-index#indexmap@2.14.0",
  "registry+https://github.com/rust-lang/crates.io-index#is_terminal_polyfill@1.70.2",
  "registry+https://github.com/rust-lang/crates.io-index#itoa@1.0.18",
  "registry+https://github.com/rust-lang/crates.io-index#libc@0.2.189",
  "registry+https://github.com/rust-lang/crates.io-index#memchr@2.8.3",
  "registry+https://github.com/rust-lang/crates.io-index#mio@1.2.3",
  "registry+https://github.com/rust-lang/crates.io-index#num-conv@0.2.2",
  "registry+https://github.com/rust-lang/crates.io-index#once_cell_polyfill@1.70.2",
  "registry+https://github.com/rust-lang/crates.io-index#pin-project-lite@0.2.17",
  "registry+https://github.com/rust-lang/crates.io-index#powerfmt@0.2.0",
  "registry+https://github.com/rust-lang/crates.io-index#proc-macro2@1.0.107",
  "registry+https://github.com/rust-lang/crates.io-index#quote@1.0.47",
  "registry+https://github.com/rust-lang/crates.io-index#ryu@1.0.23",
  "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.229",
  "registry+https://github.com/rust-lang/crates.io-index#serde_core@1.0.229",
  "registry+https://github.com/rust-lang/crates.io-index#serde_derive@1.0.229",
  "registry+https://github.com/rust-lang/crates.io-index#serde_json@1.0.151",
  "registry+https://github.com/rust-lang/crates.io-index#serde_yaml@0.9.34+deprecated",
  "registry+https://github.com/rust-lang/crates.io-index#sha1@0.10.7",
  "registry+https://github.com/rust-lang/crates.io-index#sha2@0.10.9",
  "registry+https://github.com/rust-lang/crates.io-index#signal-hook-registry@1.4.8",
  "registry+https://github.com/rust-lang/crates.io-index#socket2@0.6.5",
  "registry+https://github.com/rust-lang/crates.io-index#strsim@0.11.1",
  "registry+https://github.com/rust-lang/crates.io-index#syn@3.0.5",
  "registry+https://github.com/rust-lang/crates.io-index#time-core@0.1.9",
  "registry+https://github.com/rust-lang/crates.io-index#time-macros@0.2.32",
  "registry+https://github.com/rust-lang/crates.io-index#time@0.3.55",
  "registry+https://github.com/rust-lang/crates.io-index#tokio-macros@2.7.2",
  "registry+https://github.com/rust-lang/crates.io-index#tokio@1.53.1",
  "registry+https://github.com/rust-lang/crates.io-index#typenum@1.20.1",
  "registry+https://github.com/rust-lang/crates.io-index#unicode-ident@1.0.24",
  "registry+https://github.com/rust-lang/crates.io-index#unsafe-libyaml@0.2.11",
  "registry+https://github.com/rust-lang/crates.io-index#utf8parse@0.2.2",
  "registry+https://github.com/rust-lang/crates.io-index#version_check@0.9.5",
  "registry+https://github.com/rust-lang/crates.io-index#wasi@0.11.1+wasi-snapshot-preview1",
  "registry+https://github.com/rust-lang/crates.io-index#windows-link@0.2.1",
  "registry+https://github.com/rust-lang/crates.io-index#windows-sys@0.61.2",
  "registry+https://github.com/rust-lang/crates.io-index#zmij@1.0.23",
];

const AUDITED_LOCAL_ROOT_DEPENDENCY_EDGES = [
  "anyhow->registry+https://github.com/rust-lang/crates.io-index#anyhow@1.0.104",
  "clap->registry+https://github.com/rust-lang/crates.io-index#clap@4.6.6",
  "libc->registry+https://github.com/rust-lang/crates.io-index#libc@0.2.189",
  "serde->registry+https://github.com/rust-lang/crates.io-index#serde@1.0.229",
  "serde_json->registry+https://github.com/rust-lang/crates.io-index#serde_json@1.0.151",
  "serde_yaml->registry+https://github.com/rust-lang/crates.io-index#serde_yaml@0.9.34+deprecated",
  "sha1->registry+https://github.com/rust-lang/crates.io-index#sha1@0.10.7",
  "sha2->registry+https://github.com/rust-lang/crates.io-index#sha2@0.10.9",
  "time->registry+https://github.com/rust-lang/crates.io-index#time@0.3.55",
  "tokio->registry+https://github.com/rust-lang/crates.io-index#tokio@1.53.1",
];

const AUDITED_PROCESS_SPAWN_SITES = [
  {
    path: "native/crates/aimux/src/async_subprocess.rs",
    marker: "Command::new(&self.program);",
    command: "AsyncCommand.program",
    argv: "AsyncCommand.args plus explicit cwd/env/stdin/stdout/stderr fields",
    input: "infrastructure: all native process launches flow through this audited wrapper",
  },
  {
    path: "native/crates/aimux/src/bin/aimux.rs",
    marker: 'AsyncCommand::new("tty")',
    command: "tty",
    argv: "literal: no args",
    input: "fixed helper used only to identify the foreground TTY",
  },
  {
    path: "native/crates/aimux/src/context_compactor.rs",
    marker: 'AsyncCommand::new("/bin/sh");',
    command: "/bin/sh",
    argv: "literal -c plus configured compact command and private temp input path",
    input: "config-derived compact command; executed only when compaction is explicitly configured",
  },
  {
    path: "native/crates/aimux/src/daemon/runtime.rs",
    marker: 'std::process::Command::new("git");',
    command: "git",
    argv: 'literal -C <project_root> worktree prune --verbose [--dry-run]',
    input: "project-root path from daemon project registry; dry-run flag from caller",
  },
  {
    path: "native/crates/aimux/src/daemon/runtime/project_services.rs",
    marker: "AsyncCommand::new(&launch.command);",
    command: "current Aimux executable",
    argv: "project-service internal argv from get_aimux_project_service_launch_command",
    input: "config/runtime-derived self-launch; not arbitrary user command text",
  },
  {
    path: "native/crates/aimux/src/daemon/tmux_doctor.rs",
    marker: "AsyncCommand::new(program)",
    command: "tmux or audited tmux helper program supplied through TmuxDoctorCommandRunner",
    argv: "tmux diagnostic argv assembled by doctor/repair",
    input: "fixed repair paths plus project/session identifiers from runtime state",
  },
  {
    path: "native/crates/aimux/src/daemon/tmux_doctor.rs",
    marker: "respawn_window_argv(&target.window_id, command))?;",
    command: "tmux respawn-window target command",
    argv: "TmuxCommandSpec command/args for dashboard reload",
    input: "runtime-derived dashboard command spec",
  },
  {
    path: "native/crates/aimux/src/daemon/tmux_doctor.rs",
    marker: "native_tmux_open_hyperlink_command(),",
    command: "scripts/tmux-open-hyperlink.sh",
    argv: "literal helper path with tmux status/open-link environment",
    input: "fixed installed helper script",
  },
  {
    path: "native/crates/aimux/src/daemon/tmux_doctor.rs",
    marker: "native_tmux_control_command();",
    command: "scripts/tmux-control.sh",
    argv: "literal helper path plus tmux status action args",
    input: "fixed installed helper script",
  },
  {
    path: "native/crates/aimux/src/daemon/tmux_doctor.rs",
    marker: "native_tmux_statusline_command(),",
    command: "scripts/tmux-statusline.sh",
    argv: "literal helper path plus statusline render args",
    input: "fixed installed helper script",
  },
  {
    path: "native/crates/aimux/src/daemon_state.rs",
    marker: 'AsyncCommand::new("ps")',
    count: 2,
    command: "ps",
    argv: "literal process-inspection args",
    input: "fixed daemon liveness inspection",
  },
  {
    path: "native/crates/aimux/src/daemon_supervisor.rs",
    marker: "AsyncCommand::new(&launch.command);",
    command: "current Aimux executable",
    argv: "daemon internal argv from get_aimux_daemon_launch_command",
    input: "config/runtime-derived self-launch; not arbitrary user command text",
  },
  {
    path: "native/crates/aimux/src/dashboard_command_spec.rs",
    marker: "build_wrapped_dashboard_command(&dashboard_entrypoint)",
    command: "shell wrapper around dashboard entrypoint",
    argv: "__dashboard-internal-native plus project root and readiness marker",
    input: "runtime-derived project path/build stamp; executable is the installed Aimux binary",
  },
  {
    path: "native/crates/aimux/src/dashboard_command_spec.rs",
    marker: "TmuxCommandSpec {",
    command: "dashboard tmux command spec",
    argv: "shell-wrapped dashboard command string",
    input: "runtime-derived dashboard entrypoint",
  },
  {
    path: "native/crates/aimux/src/dashboard_command_spec.rs",
    marker: 'AsyncCommand::new("bash")',
    command: "bash",
    argv: "literal -n -c <generated dashboard command>",
    input: "syntax-checks generated dashboard shell only",
  },
  {
    path: "native/crates/aimux/src/debug_state.rs",
    marker: 'AsyncCommand::new("git")',
    command: "git",
    argv: "literal worktree inspection args",
    input: "project-root path from runtime state",
  },
  {
    path: "native/crates/aimux/src/desktop_notifier.rs",
    marker: 'AsyncCommand::new(helper_path).arg("--check").output() {',
    command: "mac notifier helper path",
    argv: "literal --check",
    input: "config/install-derived helper path",
  },
  {
    path: "native/crates/aimux/src/desktop_notifier.rs",
    marker: "AsyncCommand::new(program).args(args).output() {",
    command: "desktop notification transport program",
    argv: "transport-specific argv",
    input: "fixed transport selection plus notification text",
  },
  {
    path: "native/crates/aimux/src/git_delivery.rs",
    marker: 'Command::new("git")',
    count: 5,
    command: "git",
    argv: "literal delivery-verification args",
    input: "repo paths/refs supplied by delivery checker",
  },
  {
    path: "native/crates/aimux/src/jobs/runner.rs",
    marker: "Command::new(tool)",
    command: "job tool from JobRecord.tool",
    argv: "single structured prompt argument built from the job skill plus private material args; no shell wrapper",
    input:
      "local-only daemon job route data already authenticated as local and stored in the private job material file",
  },
  {
    path: "native/crates/aimux/src/lifecycle_orphans.rs",
    marker: 'AsyncCommand::new("kill")',
    command: "kill",
    argv: "literal -s <signal> <pid> on non-Unix fallback",
    input: "runtime-selected pid/signal for orphan cleanup",
  },
  {
    path: "native/crates/aimux/src/local_ui_server.rs",
    marker: "AsyncCommand::new(command);",
    command: "open/cmd/xdg-open",
    argv: "platform literal browser-open args with loopback URL",
    input: "runtime-derived local UI loopback URL",
  },
  {
    path: "native/crates/aimux/src/paths.rs",
    marker: 'AsyncCommand::new("git")',
    command: "git",
    argv: "literal rev-parse --git-common-dir",
    input: "cwd-derived repository root resolution",
  },
  {
    path: "native/crates/aimux/src/plugin_project_service_host.rs",
    marker: "AsyncCommand::new(command);",
    count: 2,
    command: "declared plugin subprocess command",
    argv: "plugin-supplied args after capability allow-list",
    input: "plugin/user-derived; currently constrained to gh-pr-context git/gh capabilities",
  },
  {
    path: "native/crates/aimux/src/process_inspector.rs",
    marker: 'AsyncCommand::new("ps")',
    count: 6,
    command: "ps",
    argv: "literal process inspection args",
    input: "runtime-selected pid/process filter",
  },
  {
    path: "native/crates/aimux/src/process_inspector.rs",
    marker: 'AsyncCommand::new("lsof")',
    command: "lsof",
    argv: "literal port/process inspection args",
    input: "runtime-selected pid/port filter",
  },
  {
    path: "native/crates/aimux/src/process_inspector.rs",
    marker: 'AsyncCommand::new("kill")',
    command: "kill",
    argv: "literal signal/pid args",
    input: "runtime-selected pid/signal for process cleanup",
  },
  {
    path: "native/crates/aimux/src/project_service/desktop_state.rs",
    marker: 'AsyncCommand::new("git")',
    count: 2,
    command: "git",
    argv: "literal branch inspection args",
    input: "project/worktree path from project-service state",
  },
  {
    path: "native/crates/aimux/src/project_service/lifecycle/agent_launch_routes.rs",
    marker: "wrap_agent_launch(AgentLaunchWrapInput {",
    count: 2,
    command: "agent CLI through tmux window",
    argv: "agent launch command/args plus Aimux shell integration",
    input: "user-selected agent command and task prompt; agent CLIs may be network clients",
  },
  {
    path: "native/crates/aimux/src/project_service/lifecycle/agent_session_launch.rs",
    marker: "wrap_agent_launch(AgentLaunchWrapInput {",
    count: 2,
    command: "agent CLI through tmux window",
    argv: "agent launch command/args plus Aimux shell integration",
    input: "user-selected agent command and task prompt; agent CLIs may be network clients",
  },
  {
    path: "native/crates/aimux/src/project_service/lifecycle/runtime_adapter.rs",
    marker: "new_window_argv(session_name, name, cwd, command, args, detached),",
    count: 2,
    command: "tmux new-window target command",
    argv: "command/args from lifecycle launch request",
    input: "user/config/runtime-derived session launch",
  },
  {
    path: "native/crates/aimux/src/project_service/lifecycle/runtime_adapter.rs",
    marker: 'AsyncCommand::new("gh");',
    command: "gh",
    argv: "literal PR inspection args",
    input: "user/project-derived GitHub context; external network client by user/tool choice",
  },
  {
    path: "native/crates/aimux/src/project_service/lifecycle/runtime_adapter.rs",
    marker: 'AsyncCommand::new("git");',
    command: "git",
    argv: "literal branch/worktree inspection args",
    input: "project/worktree path from project-service state",
  },
  {
    path: "native/crates/aimux/src/project_service/lifecycle/services.rs",
    marker: "build_service_launch_script(&input.launch_command_line, &shell),",
    command: "user service command through shell",
    argv: "shell -lc generated service launch script",
    input: "user-derived service command line",
  },
  {
    path: "native/crates/aimux/src/remote/remote_login.rs",
    marker: "AsyncCommand::new(command);",
    command: "remote login browser/helper command",
    argv: "remote-login helper args",
    input: "remote-control feature path; not part of local-only claim",
  },
  {
    path: "native/crates/aimux/src/remote/remote_security_devices.rs",
    marker: 'AsyncCommand::new("curl");',
    command: "curl",
    argv: "remote security device HTTP args",
    input: "remote-control feature path; not part of local-only claim",
  },
  {
    path: "native/crates/aimux/src/tmux.rs",
    marker: "new_window_argv(session_name, name, cwd, command, args, detached);",
    command: "tmux new-window target command",
    argv: "command/args from runtime launch request",
    input: "user/config/runtime-derived session launch",
  },
  {
    path: "native/crates/aimux/src/tmux.rs",
    marker: "respawn_window_argv(&target.window_id, spec),",
    command: "tmux respawn-window target command",
    argv: "TmuxCommandSpec command/args",
    input: "dashboard/statusline/tmux helper command spec",
  },
  {
    path: "native/crates/aimux/src/tmux.rs",
    marker: "TmuxCommandSpec {",
    count: 2,
    command: "tmux command spec",
    argv: "statusline/dashboard/helper command/args",
    input: "fixed helpers plus runtime metadata",
  },
  {
    path: "native/crates/aimux/src/tmux.rs",
    marker: "AsyncCommand::new(program)",
    command: "tmux or helper program",
    argv: "tmux/runtime helper argv",
    input: "runtime tmux operations",
  },
  {
    path: "native/crates/aimux/src/tmux.rs",
    marker: "AsyncCommand::new(program);",
    command: "resolved tmux binary",
    argv: "tmux command argv, with optional AIMUX_TMUX_SOCKET_PATH",
    input: "runtime tmux operations; tmux itself is resolved before spawn and never launched by bare PATH",
  },
  {
    path: "native/crates/aimux/src/tmux_control.rs",
    marker: "AsyncCommand::new(program)",
    count: 2,
    command: "tmux-control helper program",
    argv: "control helper argv",
    input: "fixed tmux control/open helper invocations",
  },
  {
    path: "native/crates/aimux/src/tmux_open_hyperlink.rs",
    marker: 'AsyncCommand::new("sh")',
    command: "sh",
    argv: "literal -c command -v <program>",
    input: "fixed existence check for open/xdg-open",
  },
  {
    path: "native/crates/aimux/src/tmux_open_hyperlink.rs",
    marker: "AsyncCommand::new(program)",
    command: "open/xdg-open",
    argv: "literal URL-open args",
    input: "URL extracted from tmux environment/current text",
  },
  {
    path: "bin/aimux",
    marker: 'exec "$AIMUX_NATIVE_BIN" "$@"',
    command: "AIMUX_NATIVE_BIN",
    argv: "passthrough CLI args",
    input: "config/env-derived explicit native binary override",
  },
  {
    path: "bin/aimux",
    marker: 'exec "$candidate" "$@"',
    command: "installed Aimux native binary candidate",
    argv: "passthrough CLI args",
    input: "fixed release/debug candidate paths under Aimux root",
  },
  {
    path: "scripts/tmux-control.sh",
    marker: "curl -fsS --max-time",
    count: 5,
    command: "curl",
    argv: "literal loopback daemon/project-service HTTP calls",
    input: "loopback endpoints from project metadata/daemon config",
  },
  {
    path: "scripts/tmux-control.sh",
    marker: "nc -U",
    command: "nc",
    argv: "literal Unix-domain Expose socket bridge",
    input: "project-state socket path only",
  },
  {
    path: "scripts/tmux-control.sh",
    marker: "run_tmux display-popup",
    count: 2,
    command: "tmux",
    argv: "literal popup/control/session argv",
    input: "tmux runtime state and user-selected navigation target; shell calls route through the resolved AIMUX_TMUX_BIN helper",
  },
  {
    path: "scripts/tmux-control.sh",
    marker: "python3 -",
    count: 9,
    command: "python3",
    argv: "inline helper scripts for JSON/menu parsing",
    input: "runtime metadata and loopback API payloads",
  },
  {
    path: "scripts/tmux-control.sh",
    marker: 'subprocess.check_output(["curl"',
    count: 2,
    command: "curl",
    argv: "literal loopback project-service fetch from inline Python",
    input: "loopback endpoint read from project metadata",
  },
  {
    path: "scripts/tmux-control.sh",
    marker: 'subprocess.run([os.environ["AIMUX_TMUX_BIN"], *args], check=True)',
    command: "tmux",
    argv: "literal display-menu argv from inline Python",
    input: "runtime switchable-agent metadata; AIMUX_TMUX_BIN is resolved by the shell wrapper before Python runs",
  },
  {
    path: "scripts/tmux-control.sh",
    marker: "subprocess.check_output([tmux_bin, *args], text=True)",
    command: "tmux",
    argv: "literal tmux metadata argv from inline Python",
    input: "runtime session/window state; tmux_bin comes from resolved AIMUX_TMUX_BIN",
  },
  {
    path: "scripts/tmux-open-hyperlink.sh",
    marker: "python3 - <<'PY'",
    count: 2,
    command: "python3",
    argv: "inline helpers for PR URL/text extraction",
    input: "tmux statusline metadata and selected terminal text",
  },
  {
    path: "scripts/tmux-open-hyperlink.sh",
    marker: "exec open \"$url\"",
    command: "open",
    argv: "URL argument",
    input: "URL extracted from project metadata or selected terminal text",
  },
  {
    path: "scripts/tmux-open-hyperlink.sh",
    marker: "exec xdg-open \"$url\"",
    command: "xdg-open",
    argv: "URL argument",
    input: "URL extracted from project metadata or selected terminal text",
  },
  {
    path: "scripts/tmux-statusline.sh",
    marker: 'mkdir -p "$log_dir"',
    command: "mkdir",
    argv: "literal -p <project-state>/logs",
    input: "project-state path from tmux command spec",
  },
  {
    path: "scripts/tmux-statusline.sh",
    marker: 'cat "$file"',
    command: "cat",
    argv: "statusline render file",
    input: "project-state statusline path only",
  },
];

const args = process.argv.slice(2);
let sourceRoot = repoRoot;
let manifestPath = join(repoRoot, "native/Cargo.toml");
let packageIdentitiesFile = null;
let expectedPackageIdentitiesFile = null;
let rootDependencyEdgesFile = null;
let expectedRootDependencyEdgesFile = null;
let cargoMetadataFile = null;
let skipPackageIdentityCheck = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--source-root") {
    sourceRoot = resolve(args[++i]);
  } else if (arg === "--manifest-path") {
    manifestPath = resolve(args[++i]);
  } else if (arg === "--package-identities-file") {
    packageIdentitiesFile = resolve(args[++i]);
  } else if (arg === "--expected-package-identities-file") {
    expectedPackageIdentitiesFile = resolve(args[++i]);
  } else if (arg === "--root-dependency-edges-file") {
    rootDependencyEdgesFile = resolve(args[++i]);
  } else if (arg === "--expected-root-dependency-edges-file") {
    expectedRootDependencyEdgesFile = resolve(args[++i]);
  } else if (arg === "--cargo-metadata-file") {
    cargoMetadataFile = resolve(args[++i]);
  } else if (arg === "--skip-package-identity-check") {
    skipPackageIdentityCheck = true;
  } else if (arg === "--write-current-package-identities") {
    const output = resolve(args[++i]);
    const identities = collectCurrentPackageSurface().packages;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${identities.join("\n")}\n`, "utf8");
    process.exit(0);
  } else {
    console.error(`Unknown check-local-network-surface argument: ${arg}`);
    process.exit(2);
  }
}

const failures = [];
let allRustSourceText = null;

function fail(message) {
  failures.push(message);
}

if (skipPackageIdentityCheck && resolve(sourceRoot) === repoRoot) {
  fail(
    "--skip-package-identity-check is only for fixture source roots. The real repository gate must include package identity checks; use scripts/check-local-network-surface.",
  );
}

function walk(dir, visit) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, visit);
    } else {
      visit(path);
    }
  }
}

function readLines(path) {
  return readFileSync(path, "utf8").split(/\r?\n/);
}

function allRustSource() {
  if (allRustSourceText !== null) return allRustSourceText;
  const srcDir = join(sourceRoot, "native/crates/aimux/src");
  const chunks = [];
  walk(srcDir, (path) => {
    if (path.endsWith(".rs")) chunks.push(readFileSync(path, "utf8"));
  });
  allRustSourceText = chunks.join("\n");
  return allRustSourceText;
}

function normalizePackageIdentity(pkg) {
  if (pkg.source === null) return `path#${pkg.name}@${pkg.version}`;
  return `${pkg.source}#${pkg.name}@${pkg.version}`;
}

function readList(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function collectCurrentPackageSurface() {
  if (packageIdentitiesFile) {
    return {
      packages: readList(packageIdentitiesFile),
      rootEdges: rootDependencyEdgesFile ? readList(rootDependencyEdgesFile) : [],
    };
  }

  if (!cargoMetadataFile) {
    throw new Error(
      "cargo metadata was not provided. Run scripts/check-local-network-surface so Cargo execution stays outside the pure JS checker.",
    );
  }
  const parsed = JSON.parse(readFileSync(cargoMetadataFile, "utf8"));
  const aimuxPackage = parsed.packages.find((pkg) => pkg.name === "aimux");
  if (!aimuxPackage) {
    throw new Error("cargo metadata did not include the aimux package");
  }
  const nodes = new Map(parsed.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(parsed.packages.map((pkg) => [pkg.id, pkg]));
  const aimuxNode = nodes.get(aimuxPackage.id);
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      visit(dep.pkg);
    }
  }
  visit(aimuxPackage.id);
  return {
    packages: [...visited].map((id) => normalizePackageIdentity(packages.get(id))).sort(),
    rootEdges: (aimuxNode?.deps ?? [])
      .map((dep) => `${dep.name}->${normalizePackageIdentity(packages.get(dep.pkg))}`)
      .sort(),
  };
}

function expectedPackageIdentities() {
  if (!expectedPackageIdentitiesFile) return [...AUDITED_LOCAL_PACKAGE_IDENTITIES].sort();
  return readList(expectedPackageIdentitiesFile);
}

function expectedRootDependencyEdges() {
  if (!expectedRootDependencyEdgesFile) return [...AUDITED_LOCAL_ROOT_DEPENDENCY_EDGES].sort();
  return readList(expectedRootDependencyEdgesFile);
}

function compareAuditedList({ label, current, expected, consequence }) {
  const currentSet = new Set(current);
  const expectedSet = new Set(expected);
  const added = current.filter((identity) => !expectedSet.has(identity));
  const removed = expected.filter((identity) => !currentSet.has(identity));
  if (added.length === 0 && removed.length === 0) return;
  fail(
    [
      `${label} changed from the audited identities`,
      consequence,
      added.length > 0 ? `added identities:\n${added.map((value) => `  + ${value}`).join("\n")}` : "",
      removed.length > 0 ? `removed identities:\n${removed.map((value) => `  - ${value}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function checkPackageIdentitySurface() {
  if (skipPackageIdentityCheck) return;
  const current = collectCurrentPackageSurface();
  compareAuditedList({
    label: "local no-default-features dependency graph",
    current: current.packages,
    expected: expectedPackageIdentities(),
    consequence:
      "This gate keys on Cargo package identity, so a renamed, aliased, or wrapped network client dependency cannot enter the local build without review.",
  });
  compareAuditedList({
    label: "local no-default-features root dependency edge set",
    current: current.rootEdges,
    expected: expectedRootDependencyEdges(),
    consequence:
      "This also freezes which audited transitive crates are directly usable from aimux source, so making an already-present network-capable transitive crate a direct dependency still requires review.",
  });
}

function normalizeSpawnMarker(value) {
  return value.replace(/\s+/g, " ").trim();
}

function matchingBraceIndex(text, openIndex) {
  let depth = 0;
  let stringQuote = null;
  let escaped = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && text[index - 1] === "*") blockCommentDepth -= 1;
      continue;
    }
    if (stringQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === stringQuote) stringQuote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockCommentDepth += 1;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      stringQuote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function removeCfgTestItems(text) {
  let current = text;
  const pattern = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g;
  let match = null;
  while ((match = pattern.exec(current)) !== null) {
    const start = match.index;
    let itemStart = pattern.lastIndex;
    while (/\s/.test(current[itemStart] ?? "")) itemStart += 1;
    const brace = current.indexOf("{", itemStart);
    const semicolon = current.indexOf(";", itemStart);
    let end = itemStart;
    if (brace !== -1 && (semicolon === -1 || brace < semicolon)) {
      const close = matchingBraceIndex(current, brace);
      end = close === -1 ? current.length : close + 1;
    } else if (semicolon !== -1) {
      end = semicolon + 1;
    }
    current = `${current.slice(0, start)}${current.slice(end)}`;
    pattern.lastIndex = start;
  }
  return current;
}

function rustSpawnPattern() {
  return new RegExp(
    [
      "\\b(?:(?:std::process::|tokio::process::)?Command|AsyncCommand|TokioCommand)::new\\s*\\([^\\n]*",
      "\\b(?:TmuxCommandSpec\\s*\\{|new_window_argv\\s*\\(|respawn_window_argv\\s*\\(|build_service_launch_script\\s*\\(|wrap_agent_launch\\s*\\(|build_wrapped_dashboard_command\\s*\\(|native_tmux_(?:statusline|control|open_hyperlink)_command\\s*\\()[^\\n]*",
    ].join("|"),
    "g",
  );
}

function isRustSpawnDefinition(marker) {
  return (
    /^pub(?:\(super\))?\s+(?:struct|fn)\s+/.test(marker) ||
    /^fn\s+/.test(marker) ||
    marker.startsWith("build_wrapped_dashboard_command(dashboard_entrypoint:") ||
    marker === "wrap_agent_launch(" ||
    marker.startsWith("build_service_launch_script(command_line:") ||
    marker === "new_window_argv(" ||
    marker.startsWith("respawn_window_argv(window_id:") ||
    marker.startsWith("native_tmux_control_command() ->") ||
    marker.startsWith("native_tmux_statusline_command() ->") ||
    marker.startsWith("native_tmux_open_hyperlink_command() ->")
  );
}

function collectRustSpawnSites() {
  const srcDir = join(sourceRoot, "native/crates/aimux/src");
  const sites = [];
  walk(srcDir, (path) => {
    if (!path.endsWith(".rs")) return;
    const rel = relative(sourceRoot, path).split("\\").join("/");
    const text = removeCfgTestItems(readFileSync(path, "utf8"));
    for (const match of text.matchAll(rustSpawnPattern())) {
      const marker = normalizeSpawnMarker(match[0]);
      if (isRustSpawnDefinition(marker)) continue;
      sites.push({ path: rel, marker });
    }
  });
  return sites;
}

function collectScriptSpawnSites() {
  const scriptMarkers = [];
  for (const audited of AUDITED_PROCESS_SPAWN_SITES) {
    if (audited.path.endsWith(".rs")) continue;
    const path = join(sourceRoot, audited.path);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const count = text.split(audited.marker).length - 1;
    for (let index = 0; index < count; index += 1) {
      scriptMarkers.push({ path: audited.path, marker: audited.marker });
    }
  }
  return scriptMarkers;
}

function siteKey(site) {
  return `${site.path}\0${site.marker}`;
}

function auditedProcessSpawnSitesForSourceRoot() {
  return AUDITED_PROCESS_SPAWN_SITES.flatMap((site) =>
    Array.from({ length: site.count ?? 1 }, () => ({
      ...site,
      marker: normalizeSpawnMarker(site.marker),
    })),
  );
}

function countBySiteKey(sites) {
  const counts = new Map();
  for (const site of sites) {
    const key = siteKey(site);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function checkProcessSpawnSurface() {
  for (const site of AUDITED_PROCESS_SPAWN_SITES) {
    for (const field of ["path", "marker", "command", "argv", "input"]) {
      if (!site[field] || !String(site[field]).trim()) {
        fail(`audited process spawn site is missing ${field}: ${JSON.stringify(site)}`);
      }
    }
  }

  const current = [...collectRustSpawnSites(), ...collectScriptSpawnSites()]
    .map((site) => ({ ...site, marker: normalizeSpawnMarker(site.marker) }))
    .sort((a, b) => siteKey(a).localeCompare(siteKey(b)));
  const audited = auditedProcessSpawnSitesForSourceRoot().sort((a, b) => siteKey(a).localeCompare(siteKey(b)));
  const auditedKeys = new Set(audited.map(siteKey));
  const currentKeys = new Set(current.map(siteKey));
  const auditedCounts = countBySiteKey(audited);
  const currentCounts = countBySiteKey(current);

  for (const site of current) {
    if (!auditedKeys.has(siteKey(site))) {
      fail(
        [
          `unclassified process spawn site: ${site.path}: ${site.marker}`,
          "Classify the spawned command, argv shape, and whether inputs are fixed, config-derived, user-derived, plugin-derived, or remote-feature-only before this can ship.",
        ].join("\n"),
      );
    }
  }

  if (resolve(sourceRoot) === repoRoot) {
    for (const site of AUDITED_PROCESS_SPAWN_SITES.map((spawn) => ({
      ...spawn,
      marker: normalizeSpawnMarker(spawn.marker),
    }))) {
      const key = siteKey(site);
      const expectedCount = auditedCounts.get(key) ?? 0;
      const actualCount = currentCounts.get(key) ?? 0;
      if (!currentKeys.has(key)) {
        fail(`audited process spawn site is stale or missing from source: ${site.path}: ${site.marker}`);
      } else if (actualCount !== expectedCount) {
        fail(
          `audited process spawn site count changed for ${site.path}: ${site.marker} (expected ${expectedCount}, got ${actualCount})`,
        );
      }
    }
  }
}

function hasRemoteControlCfgMacro(text) {
  return /cfg!\s*\([^)]*feature\s*=\s*"remote-control"/s.test(text);
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function socketTypeNames(text) {
  const names = new Set(["TcpStream", "TcpListener", "UdpSocket"]);
  const directAliasPattern = /use\s+(?:std|tokio)::net::(TcpStream|TcpListener|UdpSocket)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of text.matchAll(directAliasPattern)) names.add(match[2]);
  const braceUsePattern = /use\s+(?:std|tokio)::net::\{([^}]+)\}/g;
  for (const match of text.matchAll(braceUsePattern)) {
    for (const rawPart of match[1].split(",")) {
      const part = rawPart.trim();
      const alias = /^(TcpStream|TcpListener|UdpSocket)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(part);
      const direct = /^(TcpStream|TcpListener|UdpSocket)$/.exec(part);
      if (alias) names.add(alias[2]);
      if (direct) names.add(direct[1]);
    }
  }
  const typeAliasPattern = /type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:std|tokio)::net::(TcpStream|TcpListener|UdpSocket)\s*;/g;
  for (const match of text.matchAll(typeAliasPattern)) names.add(match[1]);
  return [...names].sort((a, b) => b.length - a.length);
}

function networkCallPatternFor(text) {
  const socketTypes = socketTypeNames(text).map(escapeRegex).join("|");
  return new RegExp(
    `\\b(?:(?:std|tokio)::net::)?(?:${socketTypes})::(?:connect|connect_timeout|bind)\\s*\\(|\\btokio::net::lookup_host\\s*\\(|\\.to_socket_addrs\\s*\\(`,
    "g",
  );
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function statementAround(text, start) {
  const end = text.indexOf(";", start);
  return text.slice(start, end === -1 ? Math.min(text.length, start + 500) : end + 1);
}

function surroundingWindow(lines, lineIndex) {
  const start = Math.max(0, lineIndex - 60);
  const end = Math.min(lines.length, lineIndex + 20);
  return lines.slice(start, end).join("\n");
}

function containsNonLoopbackLiteral(text) {
  const ipv4Matches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
  if (ipv4Matches.some((ip) => !ip.startsWith("127."))) return true;
  return /https?:\/\/(?!localhost(?:[:/"]|$)|127\.|(?:\[)?::1(?:\])?(?:[:/"]|$))[A-Za-z0-9.-]+/i.test(text);
}

function containsLoopbackEvidence(text) {
  return (
    /\b127\./.test(text) ||
    /\blocalhost\b/.test(text) ||
    /(?<![A-Za-z0-9])::1(?![A-Za-z0-9])/.test(text) ||
    /\.is_loopback\s*\(\s*\)/.test(text) ||
    /\bis_loopback_host\s*\(/.test(text) ||
    /must use loopback|must be loopback|no loopback address resolved/.test(text)
  );
}

function containsTypeBackedLoopbackEvidence(statement, window) {
  const source = allRustSource();
  return (
    /\bconfig\.host\.as_str\(\)/.test(statement) &&
    /\bDaemonListenConfig\b/.test(window) &&
    /AIMUX_DAEMON_HOST must be loopback/.test(source) &&
    /\bDaemonListenConfig\s*\{\s*host,\s*port\s*\}/.test(source)
  );
}

function checkSourceNetworkSurface() {
  const srcDir = join(sourceRoot, "native/crates/aimux/src");
  walk(srcDir, (path) => {
    if (!path.endsWith(".rs")) return;
    const rel = relative(sourceRoot, path).split("\\").join("/");
    const text = readFileSync(path, "utf8");
    if (hasRemoteControlCfgMacro(text)) {
      fail(
        `${rel} uses cfg!(feature = "remote-control"). Use a #[cfg(...)] attribute instead: #[cfg] removes code from the local build, while cfg! compiles both branches and can leave remote-control code inside the local binary even when other absence checks are green.`,
      );
    }

    if (rel.startsWith("native/crates/aimux/src/remote/")) return;
    const lines = readLines(path);
    for (const match of text.matchAll(networkCallPatternFor(text))) {
      const start = match.index ?? 0;
      const line = lineNumberAt(text, start);
      const statement = statementAround(text, start);
      const window = surroundingWindow(lines, line - 1);
      const evidence = `${statement}\n${window}`;
      if (containsNonLoopbackLiteral(statement)) {
        fail(`${rel}:${line} contains a non-loopback network target in a local-source socket call: ${statement.trim()}`);
        continue;
      }
      if (!containsLoopbackEvidence(evidence)) {
        if (containsTypeBackedLoopbackEvidence(statement, window)) {
          continue;
        }
        fail(
          `${rel}:${line} has a network socket/DNS call without auditable loopback evidence near the call. Make the address loopback literal or keep an explicit is_loopback/127.0.0.1/localhost guard adjacent to the call.`,
        );
      }
    }
  });
}

try {
  checkPackageIdentitySurface();
  checkSourceNetworkSurface();
  checkProcessSpawnSurface();
} catch (error) {
  fail(error.message);
}

if (failures.length > 0) {
  console.error("Local network surface gate failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Local network surface gate passed");
console.log(
  "checked: audited local Cargo package identities/root dependency edges, remote-control cfg! macro absence, loopback-only local socket/DNS call evidence, and audited process spawn surface",
);
