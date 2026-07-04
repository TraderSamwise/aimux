import { resolve as pathResolve } from "node:path";
import { coreCommandArgs, isCoreCliCommand, isValidCoreProjectEnsureArgs } from "./core-cli-routing.js";
import { CORE_COMMAND_NAMES, type CoreRelaySnapshot, type CoreStatusProject } from "./core-command-contract.js";
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

function readOption(args: string[], name: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      const value = args[index + 1] ?? null;
      return value && !value.startsWith("-") ? value : null;
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
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

function coreProjectServicePid(project: CoreStatusProject | null): number | null {
  const service = project?.service;
  return service && typeof service === "object" && typeof (service as { pid?: unknown }).pid === "number"
    ? (service as { pid: number }).pid
    : null;
}

function relayLastError(relay: CoreRelaySnapshot): string | null {
  return "lastError" in relay ? relay.lastError : null;
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
  if (!project) {
    io.stdout(`No known control service for ${projectRoot}`);
    return 0;
  }
  io.stdout(`Service: ${project.serviceAlive ? "live" : "idle"}`);
  const pid = coreProjectServicePid(project);
  if (pid !== null) io.stdout(`Service pid=${pid}`);
  io.stdout(`Metadata: ${project.serviceEndpoint ? JSON.stringify(project.serviceEndpoint) : "not running"}`);
  io.stdout(`Expected manifest: ${JSON.stringify(response.result.daemon.serviceInfo)}`);
  io.stdout(`Tmux session: ${project.dashboardSessionName}`);
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
  let payload: {
    daemon: unknown;
    projects: unknown[];
    relay: CoreRelaySnapshot;
  };
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
  const daemon = payload.daemon as { pid?: number; port?: number } | null;
  if (!daemon) {
    io.stdout("aimux daemon is not running.");
    return 0;
  }
  io.stdout(`Daemon pid=${daemon.pid} port=${daemon.port}`);
  const projects = payload.projects as Array<{ serviceAlive?: boolean }>;
  io.stdout(`Known projects: ${projects.length}`);
  io.stdout(`Live project services: ${projects.filter((project) => project.serviceAlive).length}`);
  const r = payload.relay;
  if (r.status && r.status !== "off") {
    io.stdout(`Relay: ${r.status}${r.relayUrl ? ` (${r.relayUrl})` : ""}`);
  } else {
    io.stdout("Relay: off");
  }
  return 0;
}

async function runDaemonProjects(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectsList);
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify({ projects: result.projects }, null, 2));
    return 0;
  }
  for (const project of result.projects) {
    const badge = project.serviceAlive ? "service" : "idle";
    io.stdout(`${project.name}  ${badge}  ${project.path}`);
  }
  return 0;
}

async function runDaemonProjectEnsure(args: string[], io: Required<CoreCliIo>): Promise<number> {
  if (!isValidCoreProjectEnsureArgs(args)) {
    io.stderr("error: invalid daemon project-ensure arguments");
    return 1;
  }
  const projectOption = readOption(args, "--project");
  if (!projectOption) {
    io.stderr("error: required option '--project <path>' not specified");
    return 1;
  }
  const projectRoot = resolveProjectRoot(pathResolve(projectOption));
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectEnsure, { projectRoot });
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify({ project: result.project }, null, 2));
    return 0;
  }
  io.stdout(`Ensured project service for ${projectRoot} (pid ${result.project.pid})`);
  return 0;
}

async function runProjectsList(args: string[], io: Required<CoreCliIo>): Promise<number> {
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectsList);
  const projects = result.projects;
  if (hasFlag(args, "--json")) {
    io.stdout(JSON.stringify({ projects }, null, 2));
    return 0;
  }
  if (projects.length === 0) {
    io.stdout("No aimux projects found.");
    return 0;
  }
  for (const project of projects) {
    const liveBadge = project.serviceAlive ? "live" : "idle";
    io.stdout(`${project.name}  ${liveBadge}  ${project.path}`);
  }
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
  if (!creds) {
    io.stdout("Not logged in. Run `aimux login` to enable remote access.");
    return 0;
  }
  io.stdout(`Remote access: ${creds.remoteEnabled ? "enabled" : "disabled"}`);
  io.stdout(`Relay: ${creds.relayUrl}`);
  io.stdout(`Connection: ${relay.status ?? "unknown"}`);
  const lastError = relayLastError(relay);
  if (lastError) io.stdout(`Last error: ${lastError}`);
  return 0;
}

async function runRemoteEnable(io: Required<CoreCliIo>): Promise<number> {
  if (!loadCredentials()) {
    io.stderr("Not logged in. Run `aimux login` first.");
    return 1;
  }
  const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.relayEnable);
  const r = result.relay;
  io.stdout(`✓ Remote access enabled (connection: ${r.status ?? "unknown"})`);
  return 0;
}

async function runRemoteDisable(io: Required<CoreCliIo>): Promise<number> {
  if (loadDaemonInfo()) {
    await requestCoreCommand(CORE_COMMAND_NAMES.relayDisable, undefined, { ensureDaemon: false, timeoutMs: 1000 });
    io.stdout("✓ Remote access disabled. Daemon disconnected from relay.");
    return 0;
  }
  setRemoteEnabled(false);
  io.stdout("✓ Remote access disabled.");
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
