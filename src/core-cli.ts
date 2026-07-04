import { resolve as pathResolve } from "node:path";
import { coreCommandArgs, isCoreCliCommand, parseCoreProjectEnsureArgs } from "./core-cli-routing.js";
import { CORE_COMMAND_NAMES, type CoreRelaySnapshot, type CoreStatusProject } from "./core-command-contract.js";
import {
  renderCoreDaemonProjectsLines,
  renderCoreDaemonStatusLines,
  renderCoreHostStatusLines,
  renderCoreProjectEnsureLines,
  renderCoreProjectsListLines,
  renderCoreRemoteDisableLines,
  renderCoreRemoteEnableLines,
  renderCoreRemoteStatusLines,
  type CoreDaemonStatusTextPayload,
} from "./core-text.js";
import { requestCoreCommand } from "./core-command-client.js";
import { loadCredentials, setRemoteEnabled } from "./credentials.js";
import { loadDaemonInfo, loadDaemonState } from "./daemon-state.js";
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
    if (command === "host" && subcommand === "status") return await runHostStatus(args, io);
    if (command === "daemon" && subcommand === "ensure") return await runDaemonEnsure(args, io);
    if (command === "daemon" && subcommand === "status") return await runDaemonStatus(args, io);
    if (command === "daemon" && subcommand === "projects") return await runDaemonProjects(args, io);
    if (command === "daemon" && subcommand === "project-ensure") return await runDaemonProjectEnsure(args, io);
    if (command === "projects" && subcommand === "list") return await runProjectsList(args, io);
    if (command === "remote" && subcommand === "status") return await runRemoteStatus(args, io);
    if (command === "remote" && subcommand === "enable") return await runRemoteEnable(io);
    if (command === "remote" && subcommand === "disable") return await runRemoteDisable(io);
    io.stderr(`unsupported core command: ${args.join(" ")}`);
    return 2;
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
