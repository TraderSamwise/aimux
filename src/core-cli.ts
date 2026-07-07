import { resolve as pathResolve } from "node:path";
import {
  coreCommandArgs,
  isCoreCliCommand,
  parseCoreDaemonRestartArgs,
  parseCoreHostRestartArgs,
  parseCoreLogsArgs,
  parseCoreProjectEnsureArgs,
  parseCoreRestartArgs,
} from "./core-cli-routing.js";
import { CORE_COMMAND_NAMES, type CoreRelaySnapshot, type CoreStatusProject } from "./core-command-contract.js";
import {
  renderCoreDaemonProjectsLines,
  renderCoreDaemonStatusLines,
  renderCoreHostStatusLines,
  renderCoreLoginLines,
  renderCoreLogoutLines,
  renderCoreProjectEnsureLines,
  renderCoreProjectKillLines,
  renderCoreProjectRestartLines,
  renderCoreProjectServeLines,
  renderCoreProjectStopLines,
  renderCoreProjectsListLines,
  renderCoreRemoteDisableLines,
  renderCoreRemoteEnableLines,
  renderCoreRemoteStatusLines,
  renderCoreSecurityUnlockLines,
  renderCoreWhoamiLines,
  coreWhoamiJson,
  type CoreDaemonStatusTextPayload,
} from "./core-text.js";
import { restartControlPlaneFromCli } from "./control-plane-restart-client.js";
import { requestCoreCommand } from "./core-command-client.js";
import { clearCredentials, loadCredentials, setRemoteEnabled } from "./credentials.js";
import { loadDaemonInfo, loadDaemonState } from "./daemon-state.js";
import { runLoginFlow } from "./login-flow.js";
import { clearLogFile, parseLineCount, readLastLogLines, selectedLogPath } from "./logs.js";
import { initPaths } from "./paths.js";
import { findMainRepo } from "./worktree.js";

interface CoreCliIo {
  cwd?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const defaultIo: Required<CoreCliIo> = {
  cwd: () => process.cwd(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

function ioFor(io: CoreCliIo): Required<CoreCliIo> {
  return { ...defaultIo, ...io };
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function resolveProjectRoot(cwd: string): string {
  try {
    return findMainRepo(cwd);
  } catch {
    return cwd;
  }
}

function findCoreProject(projects: CoreStatusProject[], projectRoot: string): CoreStatusProject | null {
  const resolvedRoot = pathResolve(projectRoot);
  return projects.find((project) => pathResolve(project.path) === resolvedRoot) ?? null;
}

async function runHostStatus(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const projectRoot = resolveProjectRoot(io.cwd());
  await initPaths(projectRoot);
  const response = await requestCoreCommand(CORE_COMMAND_NAMES.status);
  const project = findCoreProject(response.result.projects, projectRoot);
  const payload = {
    projectRoot,
    sessionName: project?.dashboardSessionName ?? null,
    daemon: response.result.daemon,
    projectService: project?.service ?? null,
    serviceAlive: project?.serviceAlive ?? false,
    metadataEndpoint: project?.serviceEndpoint ?? null,
    expectedServiceManifest: response.result.daemon.serviceInfo,
  };
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify(payload, null, 2));
    return 0;
  }
  renderCoreHostStatusLines(payload, Boolean(project)).forEach(io.stdout);
  return 0;
}

async function runDaemonEnsure(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.status);
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify({ daemon: result.daemon }, null, 2));
    return 0;
  }
  io.stdout(`aimux daemon: pid ${result.daemon.pid} on http://127.0.0.1:${result.daemon.port}`);
  return 0;
}

async function runDaemonStatus(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const info = loadDaemonInfo();
  const state = loadDaemonState();
  let payload: CoreDaemonStatusTextPayload;
  try {
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.status, undefined, {
      ensureDaemon: false,
      timeoutMs: 1000,
    });
    const serviceAliveById = new Map(result.projects.map((project) => [project.id, project.serviceAlive]));
    payload = {
      daemon: result.daemon,
      projects: Object.values(state.projects).map((project) => ({
        ...project,
        serviceAlive: serviceAliveById.get(project.projectId) ?? false,
      })),
      relay: result.relay,
    };
  } catch {
    payload = {
      daemon: info,
      projects: Object.values(state.projects).map((project) => ({ ...project, serviceAlive: false })),
      relay: { status: "off" },
    };
  }
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify(payload, null, 2));
    return 0;
  }
  renderCoreDaemonStatusLines(payload).forEach(io.stdout);
  return 0;
}

async function runDaemonProjects(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectsList);
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify({ projects: result.projects }, null, 2));
    return 0;
  }
  renderCoreDaemonProjectsLines(result.projects).forEach(io.stdout);
  return 0;
}

async function runDaemonProjectEnsure(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const parsedArgs = parseCoreProjectEnsureArgs(args);
  if (!parsedArgs) {
    io.stderr("error: invalid daemon project-ensure arguments");
    return 1;
  }
  const projectRoot = resolveProjectRoot(pathResolve(parsedArgs.project));
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectEnsure, { projectRoot });
  const payload = { project: result.project };
  if (parsedArgs.json) {
    io.stdout(JSON.stringify(payload, null, 2));
    return 0;
  }
  renderCoreProjectEnsureLines(payload).forEach(io.stdout);
  return 0;
}

async function runRestart(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const parsedArgs = args[0] === "daemon" ? parseCoreDaemonRestartArgs(args) : parseCoreRestartArgs(args);
  if (!parsedArgs) {
    io.stderr("error: invalid restart arguments");
    return 1;
  }
  const restartArgs = args[0] === "daemon" ? null : parseCoreRestartArgs(args);
  const projectRoot = restartArgs?.project ? resolveProjectRoot(pathResolve(restartArgs.project)) : undefined;
  const result = await restartControlPlaneFromCli(projectRoot);
  if (parsedArgs.json) {
    io.stdout(JSON.stringify(result.restart, null, 2));
  } else {
    io.stdout(result.text);
  }
  return result.restart.summary.failures > 0 ? 1 : 0;
}

async function runProjectServe(io: Required<CoreCliIo>): Promise<number> {
  const projectRoot = resolveProjectRoot(io.cwd());
  await initPaths(projectRoot);
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectEnsure, { projectRoot });
  renderCoreProjectServeLines({ project: result.project }).forEach(io.stdout);
  return 0;
}

async function runHostService(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const projectRoot = resolveProjectRoot(io.cwd());
  await initPaths(projectRoot);
  const [, subcommand] = args;
  if (subcommand === "stop") {
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectStop, { projectRoot });
    renderCoreProjectStopLines({ projectRoot, project: result.project }).forEach(io.stdout);
    return 0;
  }
  if (subcommand === "kill") {
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectKill, { projectRoot });
    renderCoreProjectKillLines({ projectRoot, project: result.project }).forEach(io.stdout);
    return 0;
  }
  const restartArgs = parseCoreHostRestartArgs(args);
  if (!restartArgs) {
    io.stderr("error: invalid host restart arguments");
    return 1;
  }
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectRestart, {
    projectRoot,
    serve: restartArgs.serve,
  });
  renderCoreProjectRestartLines({
    projectRoot,
    project: result.project,
    dashboardSessionName: result.dashboardSessionName,
    dashboardTarget: result.dashboardTarget,
  }).forEach(io.stdout);
  if (restartArgs.open && result.dashboardTarget) {
    const { openTmuxTargetFromCaller } = await import("./core-cli-open.js");
    openTmuxTargetFromCaller(result.dashboardTarget);
  } else if (restartArgs.open) {
    io.stderr("error: restarted project service, but no dashboard target was available to open");
    return 1;
  }
  return 0;
}

async function runLogs(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const parsed = parseCoreLogsArgs(args);
  if (!parsed) {
    io.stderr("error: invalid logs arguments");
    return 1;
  }
  if (!parsed.daemon && !parsed.project) {
    await initPaths(resolveProjectRoot(io.cwd()));
  }
  const path = selectedLogPath({ daemon: parsed.daemon, project: parsed.project });
  if (parsed.subcommand === "path") {
    io.stdout(path);
    return 0;
  }
  if (parsed.subcommand === "tail") {
    const output = readLastLogLines(path, parseLineCount(parsed.lines));
    if (!output) {
      io.stderr(`No log entries at ${path}`);
      return 1;
    }
    io.stdout(output);
    return 0;
  }
  clearLogFile(path);
  io.stdout(`Cleared ${path}`);
  return 0;
}

async function runProjectsList(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectsList);
  const projects = result.projects;
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify({ projects }, null, 2));
    return 0;
  }
  renderCoreProjectsListLines(projects).forEach(io.stdout);
  return 0;
}

async function runRemoteStatus(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const creds = loadCredentials();
  let relay: CoreRelaySnapshot = { status: "off" };
  if (loadDaemonInfo()) {
    try {
      const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.relayStatus, undefined, {
        ensureDaemon: false,
        timeoutMs: 1000,
      });
      relay = result.relay;
    } catch {
      relay = { status: "off" };
    }
  }
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify({ loggedIn: Boolean(creds), relay }, null, 2));
    return 0;
  }
  renderCoreRemoteStatusLines({
    credentials: creds ? { relayUrl: creds.relayUrl, remoteEnabled: creds.remoteEnabled } : null,
    relay,
  }).forEach(io.stdout);
  return 0;
}

async function runRemoteEnable(io: Required<CoreCliIo>): Promise<number> {
  if (!loadCredentials()) {
    io.stderr("Not logged in. Run `aimux login` first.");
    return 1;
  }
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.relayEnable);
  renderCoreRemoteEnableLines(result.relay).forEach(io.stdout);
  return 0;
}

async function runRemoteDisable(io: Required<CoreCliIo>): Promise<number> {
  if (loadDaemonInfo()) {
    await requestCoreCommand(CORE_COMMAND_NAMES.relayDisable, undefined, { ensureDaemon: false, timeoutMs: 1000 });
    renderCoreRemoteDisableLines(true).forEach(io.stdout);
    return 0;
  }
  setRemoteEnabled(false);
  renderCoreRemoteDisableLines(false).forEach(io.stdout);
  return 0;
}

async function enableRelayBestEffort(): Promise<CoreRelaySnapshot> {
  if (!loadDaemonInfo()) return { status: "off" };
  try {
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.relayEnable, undefined, {
      ensureDaemon: false,
      timeoutMs: 1000,
    });
    return result.relay;
  } catch (error) {
    return {
      status: "disconnected",
      relayUrl: "",
      lastConnectedAt: null,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runWhoami(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const creds = loadCredentials();
  const payload = {
    credentials: creds
      ? {
          userId: creds.userId,
          relayUrl: creds.relayUrl,
          remoteEnabled: creds.remoteEnabled,
        }
      : null,
  };
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify(coreWhoamiJson(payload), null, 2));
    return 0;
  }
  renderCoreWhoamiLines(payload).forEach(io.stdout);
  return 0;
}

async function runLogout(io: Required<CoreCliIo>): Promise<number> {
  if (loadDaemonInfo()) {
    try {
      await requestCoreCommand(CORE_COMMAND_NAMES.relayDisable, undefined, { ensureDaemon: false, timeoutMs: 1000 });
    } catch {}
  }
  const result = clearCredentials();
  renderCoreLogoutLines(result).forEach(result === "failed" ? io.stderr : io.stdout);
  return result === "failed" ? 1 : 0;
}

async function runLogin(io: Required<CoreCliIo>): Promise<number> {
  const { userId } = await runLoginFlow();
  const relay = await enableRelayBestEffort();
  renderCoreLoginLines({ userId, relay }).forEach(io.stdout);
  return 0;
}

async function runSecurityUnlock(io: Required<CoreCliIo>): Promise<number> {
  const { userId } = await runLoginFlow({ action: "security-unlock" });
  const relay = await enableRelayBestEffort();
  renderCoreSecurityUnlockLines({ userId, relay }).forEach(io.stdout);
  return 0;
}

export async function runCoreCli(
  rawArgs: string[] = process.argv.slice(2),
  ioOptions: CoreCliIo = {},
): Promise<number> {
  const io = ioFor(ioOptions);
  const args = coreCommandArgs(rawArgs);
  const [command, subcommand] = args;
  try {
    if (!isCoreCliCommand(args)) {
      io.stderr(`unsupported core command: ${args.join(" ")}`);
      return 2;
    }
    if (command === "restart") return await runRestart(args, io);
    if (command === "host" && subcommand === "status") return await runHostStatus(args, io);
    if (command === "serve") return await runProjectServe(io);
    if (command === "host" && ["stop", "kill", "restart"].includes(subcommand ?? "")) {
      return await runHostService(args, io);
    }
    if (command === "daemon" && subcommand === "ensure") return await runDaemonEnsure(args, io);
    if (command === "daemon" && subcommand === "restart") return await runRestart(args, io);
    if (command === "daemon" && subcommand === "status") return await runDaemonStatus(args, io);
    if (command === "daemon" && subcommand === "projects") return await runDaemonProjects(args, io);
    if (command === "daemon" && subcommand === "project-ensure") return await runDaemonProjectEnsure(args, io);
    if (command === "logs") return await runLogs(args, io);
    if (command === "projects" && subcommand === "list") return await runProjectsList(args, io);
    if (command === "remote" && subcommand === "status") return await runRemoteStatus(args, io);
    if (command === "remote" && subcommand === "enable") return await runRemoteEnable(io);
    if (command === "remote" && subcommand === "disable") return await runRemoteDisable(io);
    if (command === "whoami") return await runWhoami(args, io);
    if (command === "logout") return await runLogout(io);
    if (command === "login") return await runLogin(io);
    if (command === "security" && subcommand === "unlock") return await runSecurityUnlock(io);
    io.stderr(`unsupported core command: ${args.join(" ")}`);
    return 2;
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
