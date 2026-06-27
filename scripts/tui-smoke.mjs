#!/usr/bin/env node
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = parseArgs(process.argv.slice(2));

if (argv.iterations > 1) {
  for (let i = 1; i <= argv.iterations; i += 1) {
    console.log(`\n[tui-smoke] iteration ${i}/${argv.iterations}`);
    const args = [
      process.execPath,
      fileURLToPath(import.meta.url),
      "--iterations",
      "1",
      "--cycles",
      String(argv.cycles),
      ...(argv.chaos ? ["--chaos"] : []),
      ...(argv.keep ? ["--keep"] : []),
    ];
    const result = await run(args, {
      cwd: root,
      env: sanitizeProcessEnv(process.env),
      timeoutMs: 120000,
      allowFailure: true,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.code !== 0) {
      process.exitCode = result.code ?? 1;
      process.exit();
    }
  }
  process.exit();
}

const runId = `aimux-smoke-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
const tmpRoot = await mkdtemp(join(tmpdir(), `${runId}-`));
const artifactsDir = join(tmpRoot, "artifacts");
const homeDir = join(tmpRoot, "home");
const binDir = join(tmpRoot, "bin");
const repoRootPath = join(tmpRoot, "repos", "project-a");
const tmuxClient = `${runId}-client`;
const port = await findOpenPort();
let tmuxTarget = tmuxClient;

mkdirSync(artifactsDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(repoRootPath, { recursive: true });

const repoRoot = realpathSync(repoRootPath);
const projectName = basename(repoRoot);

const cliShim = join(binDir, "aimux");
const smokeAgent = join(binDir, "aimux-smoke-agent");
writeExecutable(cliShim, `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, "dist/main.js"))} "$@"\n`);
writeExecutable(
  smokeAgent,
  `#!/usr/bin/env bash
echo "SMOKE_AGENT_READY $AIMUX_SESSION_ID"
while true; do
  printf "> "
  if ! IFS= read -r line; then
    sleep 0.2
    continue
  fi
  case "$line" in
    exit|quit)
      echo "SMOKE_AGENT_EXIT"
      exit 0
      ;;
    *)
      echo "SMOKE_AGENT_ECHO $line"
      ;;
  esac
done
`,
);

const baseEnv = sanitizeProcessEnv(process.env);
const env = {
  ...baseEnv,
  AIMUX_HOME: join(homeDir, ".aimux"),
  AIMUX_DAEMON_HOST: "127.0.0.1",
  AIMUX_DAEMON_PORT: String(port),
  AIMUX_ENV: "test",
  AIMUX_WEB_APP_URL: "http://127.0.0.1:9",
  AIMUX_CLI_BIN: cliShim,
  AIMUX_INSTALL_ROOT: join(tmpRoot, "native"),
  PATH: `${binDir}:${process.env.PATH ?? ""}`,
  TERM: process.env.TERM || "xterm-256color",
};
const DASHBOARD_ENV_KEYS = [
  "AIMUX_HOME",
  "AIMUX_DAEMON_HOST",
  "AIMUX_DAEMON_PORT",
  "AIMUX_ENV",
  "AIMUX_WEB_APP_URL",
  "AIMUX_CLI_BIN",
  "AIMUX_INSTALL_ROOT",
  "PATH",
  "TERM",
];

const startedAt = Date.now();
let failed = false;

try {
  ensureBuilt();
  await setupRepo();
  await runCli(["init"], { cwd: repoRoot });
  configureProject();

  await runCli(["daemon", "ensure", "--json"], { cwd: repoRoot, json: true });
  await runCli(["serve"], { cwd: repoRoot });

  await startDashboard();
  await waitForDashboardStable("initial dashboard");
  await assertNoBlockingOverlay("initial dashboard");

  let sessionId = await spawnSmokeAgent("initial smoke agent");
  await exerciseSmokeAgent("smoke-one");

  for (let cycle = 1; cycle <= argv.cycles; cycle += 1) {
    if (argv.chaos) {
      await rapidAgentDashboardRoundTrips(`cycle ${cycle} rapid navigation`);
      await restartAimux(`cycle ${cycle} pre-stop restart`);
    }

    await stopSmokeAgent(sessionId, `cycle ${cycle}`);
    if (argv.chaos) await restartAimux(`cycle ${cycle} stopped-agent restart`);
    sessionId = await spawnSmokeAgent(`cycle ${cycle} respawned smoke agent`);
    await exerciseSmokeAgent(`smoke-cycle-${cycle}`);
  }

  await restartAimux("final restart");
  await waitForDashboardStable("dashboard after aimux restart");
  await assertNoBlockingOverlay("dashboard after aimux restart");

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        projectRoot: repoRoot,
        daemonPort: port,
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
} catch (err) {
  failed = true;
  await captureArtifacts(err);
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  console.error(`Artifacts: ${artifactsDir}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  if (!argv.keep && !failed) {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } else {
    console.error(`Kept smoke workspace: ${tmpRoot}`);
  }
}

function parseArgs(args) {
  const parsed = {
    iterations: 1,
    cycles: 1,
    chaos: false,
    keep: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--keep") {
      parsed.keep = true;
    } else if (arg === "--chaos") {
      parsed.chaos = true;
    } else if (arg === "--cycles") {
      parsed.cycles = Number(args[++i] ?? "1");
    } else if (arg.startsWith("--cycles=")) {
      parsed.cycles = Number(arg.slice("--cycles=".length));
    } else if (arg === "--iterations") {
      parsed.iterations = Number(args[++i] ?? "1");
    } else if (arg.startsWith("--iterations=")) {
      parsed.iterations = Number(arg.slice("--iterations=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!Number.isInteger(parsed.cycles) || parsed.cycles < 0) {
    throw new Error("--cycles must be a non-negative integer");
  }
  return parsed;
}

function ensureBuilt() {
  const entry = join(root, "dist/main.js");
  if (!existsSync(entry)) {
    throw new Error("dist/main.js is missing; run `yarn build` before tui smoke");
  }
}

async function setupRepo() {
  writeFileSync(join(repoRoot, "README.md"), "# Aimux smoke fixture\n");
  await run(["git", "init"], { cwd: repoRoot });
  await run(["git", "config", "user.email", "smoke@example.test"], { cwd: repoRoot });
  await run(["git", "config", "user.name", "Aimux Smoke"], { cwd: repoRoot });
  await run(["git", "add", "README.md"], { cwd: repoRoot });
  await run(["git", "commit", "-m", "initial smoke fixture"], { cwd: repoRoot });
}

function configureProject() {
  const configPath = join(repoRoot, ".aimux", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.defaultTool = "smoke";
  config.notifications = {
    ...config.notifications,
    enabled: false,
    onPrompt: false,
    onError: false,
    onComplete: false,
  };
  config.runtime = {
    ...config.runtime,
    agentPreambleEnabled: false,
    tmux: {
      ...(config.runtime?.tmux ?? {}),
      sessionPrefix: runId,
    },
  };
  config.tools = {
    ...config.tools,
    smoke: {
      command: smokeAgent,
      args: [],
      enabled: true,
      wrapperEnabled: false,
      promptPatterns: ["^> $"],
      turnPatterns: ["^>\\s*(.+)"],
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function startDashboard() {
  const dashboardEnv = Object.fromEntries(DASHBOARD_ENV_KEYS.flatMap((key) => (env[key] ? [[key, env[key]]] : [])));
  const command = [
    "cd",
    shellQuote(repoRoot),
    "&&",
    "env",
    ...Object.entries(dashboardEnv).map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(cliShim),
  ].join(" ");
  await run(["tmux", "new-session", "-d", "-s", tmuxClient, "-c", repoRoot, command], {
    cwd: repoRoot,
    env,
  });
}

async function focusSelectedAgent() {
  await selectWindow((window) => window.name !== "dashboard");
}

async function returnToDashboard() {
  await selectWindow((window) => window.name === "dashboard");
}

async function spawnSmokeAgent(label) {
  const spawnResult = await runCli(["spawn", "--tool", "smoke", "--project", repoRoot, "--no-open", "--json"], {
    cwd: repoRoot,
    json: true,
    timeoutMs: 15000,
  });
  assert(spawnResult.sessionId, `${label}: spawn did not return a session id`);
  await waitForScreen((screen) => screen.includes("ready") && /Agents:\s*[1-9]/.test(screen), label);
  await assertNoBlockingOverlay(label);
  return spawnResult.sessionId;
}

async function stopSmokeAgent(sessionId, label) {
  const result = await runCli(["stop", sessionId, "--project", repoRoot, "--json"], {
    cwd: repoRoot,
    json: true,
    timeoutMs: 20000,
  });
  assert(result.status === "offline", `${label}: stop returned ${JSON.stringify(result)}`);
  await waitForScreen(
    (screen) => /\d+ offline/.test(screen) && !screen.includes("ready"),
    `${label} stopped agent`,
  );
  await assertNoBlockingOverlay(`${label} stopped agent`);
}

async function exerciseSmokeAgent(message) {
  await focusSelectedAgent();
  await waitForScreen((screen) => screen.includes("SMOKE_AGENT_READY") || screen.includes(">"), `${message} prompt`);
  await tmuxSend([message, "Enter"]);
  await waitForScreen((screen) => screen.includes(`SMOKE_AGENT_ECHO ${message}`), `${message} echo`);
  await returnToDashboard();
  await waitForDashboardStable(`${message} dashboard return`);
  await assertNoBlockingOverlay(`${message} dashboard return`);
}

async function restartAimux(label) {
  const result = await runCli(["restart", "--json"], { cwd: repoRoot, json: true, timeoutMs: 30000 });
  assert(result.summary?.failures === 0, `${label}: restart reported failures ${JSON.stringify(result.summary)}`);
  await waitForDashboardStable(`${label} dashboard stable`);
  await assertNoBlockingOverlay(`${label} dashboard stable`);
}

async function rapidAgentDashboardRoundTrips(label) {
  for (let i = 0; i < 3; i += 1) {
    await focusSelectedAgent();
    await sleep(100);
    await returnToDashboard();
    await sleep(100);
  }
  await waitForDashboardStable(label);
  await assertNoBlockingOverlay(label);
}

async function waitForDashboardStable(label) {
  await waitForScreen(
    (screen) =>
      screen.includes("aimux") &&
      screen.includes("WORKTREE") &&
      screen.includes("Main Checkout") &&
      !screen.includes("AIMUX IS RECONNECTING") &&
      !screen.includes("REPAIRING AIMUX"),
    label,
    20000,
  );
}

async function assertNoBlockingOverlay(label) {
  const screen = await capturePane();
  const blocked = [
    "PROJECT SERVICE UNREACHABLE",
    "DASHBOARD OUT OF SYNC",
    "TMUX RUNTIME REBUILD REQUIRED",
    "FAILED TO",
    "AIMUX IS RECONNECTING",
    "REPAIRING AIMUX",
    "status err",
  ].find((needle) => screen.includes(needle));
  assert(!blocked, `${label}: blocking overlay still visible: ${blocked}`);
}

async function waitForScreen(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastScreen = "";
  while (Date.now() < deadline) {
    lastScreen = await capturePane();
    if (predicate(lastScreen)) return lastScreen;
    await sleep(250);
  }
  await writeFile(join(artifactsDir, `timeout-${safeName(label)}.txt`), lastScreen);
  throw new Error(`timed out waiting for ${label}`);
}

async function capturePane(target = tmuxClient) {
  const resolvedTarget = target === tmuxClient ? await resolveTmuxTarget() : target;
  const result = await run(["tmux", "capture-pane", "-p", "-J", "-t", resolvedTarget], {
    cwd: repoRoot,
    env,
    allowFailure: true,
    timeoutMs: 3000,
  });
  return `${result.stdout}${result.stderr}`;
}

async function tmuxSend(keys) {
  const target = await resolveTmuxTarget();
  await run(["tmux", "send-keys", "-t", target, ...keys], { cwd: repoRoot, env });
}

async function selectWindow(predicate) {
  const session = await resolveTmuxTarget();
  const windows = await listWindows(session);
  const target = windows.find(predicate);
  assert(target, `no tmux window matched selection predicate in ${session}`);
  await run(["tmux", "select-window", "-t", `${session}:${target.index}`], { cwd: repoRoot, env });
}

async function runCli(args, opts = {}) {
  const result = await run([cliShim, ...args], {
    cwd: opts.cwd ?? repoRoot,
    env,
    timeoutMs: opts.timeoutMs ?? 10000,
    allowFailure: opts.allowFailure,
  });
  if (opts.json) {
    try {
      return JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(`failed to parse JSON from aimux ${args.join(" ")}: ${result.stdout || result.stderr}`, {
        cause: err,
      });
    }
  }
  return result;
}

async function captureArtifacts(err) {
  mkdirSync(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, "error.txt"), err instanceof Error ? err.stack || err.message : String(err));
  await writeFile(join(artifactsDir, "dashboard.txt"), await capturePane());
  await writeCommandArtifact("tmux-ls.txt", ["tmux", "ls"]);
  await writeCommandArtifact("tmux-windows.txt", ["tmux", "list-windows", "-a", "-F", "#{session_name}:#{window_index}:#{window_id}:#{window_name}:#{window_active}:#{pane_current_command}:#{pane_current_path}"]);
  await writeCliArtifact("doctor-versions.json", ["doctor", "versions", "--json"]);
  await writeCliArtifact("doctor-tmux.json", ["doctor", "tmux", "--project-root", repoRoot, "--json"]);
  await writeCliArtifact("daemon-status.json", ["daemon", "status", "--json"]);
  await writeCliArtifact("daemon-projects.json", ["daemon", "projects", "--json"]);
  await copyLogArtifact("daemon.log", ["logs", "path", "--daemon"]);
  await copyLogArtifact("project.log", ["logs", "path", "--project", repoRoot]);
}

async function writeCommandArtifact(name, args) {
  const result = await run(args, { cwd: repoRoot, env, allowFailure: true, timeoutMs: 5000 });
  await writeFile(join(artifactsDir, name), `${result.stdout}${result.stderr}`);
}

async function writeCliArtifact(name, args) {
  const result = await runCli(args, { allowFailure: true, timeoutMs: 8000 });
  await writeFile(join(artifactsDir, name), `${result.stdout ?? ""}${result.stderr ?? ""}`);
}

async function copyLogArtifact(name, args) {
  const result = await runCli(args, { allowFailure: true, timeoutMs: 5000 });
  const path = `${result.stdout}`.trim();
  if (path && existsSync(path)) {
    await writeFile(join(artifactsDir, name), readFileSync(path, "utf8"));
  } else {
    await writeFile(join(artifactsDir, name), `${result.stdout}${result.stderr}`);
  }
}

async function cleanup() {
  await runCli(["stop", "--project", repoRoot, "--json"], { allowFailure: true, timeoutMs: 15000 });
  await runCli(["daemon", "stop"], { allowFailure: true, timeoutMs: 5000 });
  const sessions = await listTmuxSessions();
  for (const session of sessions.filter((name) => name.startsWith(runId))) {
    await run(["tmux", "kill-session", "-t", session], { cwd: repoRoot, env, allowFailure: true, timeoutMs: 3000 });
  }
}

async function resolveTmuxTarget() {
  const sessions = await listTmuxSessions();
  if (sessions.includes(tmuxTarget)) return tmuxTarget;
  const clientSession = sessions.find((name) => name.startsWith(`${runId}-${projectName}-`) && name.includes("-client-"));
  if (clientSession) {
    tmuxTarget = clientSession;
    return tmuxTarget;
  }
  const managedSession = sessions.find((name) => name.startsWith(`${runId}-${projectName}-`));
  if (managedSession) {
    tmuxTarget = managedSession;
    return tmuxTarget;
  }
  return tmuxTarget;
}

async function listTmuxSessions() {
  const result = await run(["tmux", "list-sessions", "-F", "#{session_name}"], {
    cwd: repoRoot,
    env,
    allowFailure: true,
    timeoutMs: 3000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function listWindows(sessionName) {
  const result = await run(["tmux", "list-windows", "-t", sessionName, "-F", "#{window_index}\t#{window_name}"], {
    cwd: repoRoot,
    env,
    allowFailure: true,
    timeoutMs: 3000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, name] = line.split("\t");
      return { index, name };
    });
}

async function run(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000;
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: opts.cwd ?? root,
      env: opts.env ?? env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      finish(new Error(`${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (opts.allowFailure) {
        finish(null, { code: null, signal: null, stdout, stderr: `${stderr}${err.message}\n` });
      } else {
        finish(err);
      }
    });
    child.on("close", (code, signal) => {
      if (code === 0 || opts.allowFailure) {
        finish(null, { code, signal, stdout, stderr });
      } else {
        finish(new Error(`${args.join(" ")} failed with ${code ?? signal}\n${stdout}${stderr}`));
      }
    });
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolvePromise(value);
    }
  });
}

async function findOpenPort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePromise(address.port);
        else reject(new Error("failed to allocate a local port"));
      });
    });
    server.on("error", reject);
  });
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sanitizeProcessEnv(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("GIT_")));
}
