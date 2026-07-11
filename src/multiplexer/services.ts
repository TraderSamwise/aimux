import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findMainRepo } from "../worktree.js";
import { getProjectStateDirFor, getStatePath } from "../paths.js";
import { writeJsonAtomic } from "../atomic-write.js";
import type { ServiceState } from "./index.js";
import { wrapCommandWithShellIntegration, wrapInteractiveShellWithIntegration } from "../shell-hooks.js";
import { markLastUsed } from "../last-used.js";
import {
  removeTopologyService,
  upsertTopologyService,
  type RuntimeTopologyServiceState,
} from "../runtime-core/topology-services.js";
import type { TmuxTarget } from "../tmux/runtime-manager.js";

type ServiceHost = any;

export function generateServiceId(): string {
  return `service-${randomUUID().slice(0, 8)}`;
}

function projectRootFor(host: ServiceHost): string {
  return typeof host.projectRoot === "string" && host.projectRoot.trim() ? host.projectRoot.trim() : process.cwd();
}

export function getServiceLaunchCommandLine(metadata: { command?: string; args?: string[] }): string {
  return metadata.args?.[0] === "-lc" ? (metadata.args[1] ?? "") : "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildServiceLaunchScript(commandLine: string, shellPath: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return "";
  const quotedShell = shellQuote(shellPath);
  return [
    `${trimmed}`,
    "_aimux_service_status=$?",
    'if [ "$_aimux_service_status" -ne 0 ]; then',
    '  printf "\\n[aimux] Service command exited with status %s. Dropping into an interactive shell for debugging.\\n" "$_aimux_service_status"',
    `  exec ${quotedShell} -i`,
    "fi",
    'exit "$_aimux_service_status"',
  ].join("; ");
}

export function buildServiceStateFromMetadata(
  serviceId: string,
  metadata: {
    command?: string;
    args?: string[];
    createdAt?: string;
    worktreePath?: string;
    label?: string;
    launchCommandLine?: string;
  },
  opts: { cwd?: string; tmuxTarget?: ServiceState["tmuxTarget"]; retained?: boolean } = {},
): ServiceState {
  const launchCommandLine = metadata.launchCommandLine?.trim() || getServiceLaunchCommandLine(metadata);
  return {
    id: serviceId,
    createdAt: metadata.createdAt,
    worktreePath: metadata.worktreePath,
    cwd: opts.cwd,
    label: metadata.label,
    launchCommandLine,
    tmuxTarget: opts.tmuxTarget,
    retained: opts.retained,
  };
}

function markServiceUsed(host: ServiceHost, serviceId: string): void {
  try {
    if (typeof host.noteLastUsedItem === "function") {
      host.noteLastUsedItem(serviceId);
      return;
    }
    if (host.mode === "dashboard" || host.mode === "project-service") {
      markLastUsed(projectRootFor(host), {
        itemId: serviceId,
        clientSession: host.tmuxRuntimeManager?.currentClientSession?.() ?? undefined,
      });
    }
  } catch {}
}

function commitServiceState(host: ServiceHost, options: { upsert?: ServiceState[]; removeIds?: string[] } = {}) {
  const statePath = getStatePath();
  let state: Record<string, unknown> = {};
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    } catch {}
  }
  const byId = new Map<string, ServiceState>();
  for (const service of host.offlineServices ?? []) {
    byId.set(service.id, service);
  }
  for (const service of options.upsert ?? []) {
    byId.set(service.id, service);
  }
  for (const serviceId of options.removeIds ?? []) {
    byId.delete(serviceId);
  }
  writeJsonAtomic(statePath, {
    ...state,
    savedAt: new Date().toISOString(),
    cwd: projectRootFor(host),
    services: [...byId.values()],
  });
  host.invalidateDesktopStateSnapshot();
}

function suppressNextShellReports(projectRoot: string, serviceId: string, count: number): void {
  try {
    const dir = join(getProjectStateDirFor(projectRoot), "shell-state-suppress");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, serviceId), String(Math.max(1, count)));
  } catch {}
}

function serviceMetadataToTopologyState(
  serviceId: string,
  metadata: {
    command?: string;
    args?: string[];
    createdAt?: string;
    worktreePath?: string;
    label?: string;
    launchCommandLine?: string;
  },
  opts: { cwd?: string; tmuxTarget?: ServiceState["tmuxTarget"] } = {},
): RuntimeTopologyServiceState {
  return {
    id: serviceId,
    command: metadata.command,
    args: metadata.args ?? [],
    createdAt: metadata.createdAt?.trim() || undefined,
    worktreePath: metadata.worktreePath,
    cwd: opts.cwd,
    label: metadata.label,
    launchCommandLine: metadata.launchCommandLine?.trim() || getServiceLaunchCommandLine(metadata),
    tmuxTarget: opts.tmuxTarget,
  };
}

function serviceStateToTopologyState(service: ServiceState): RuntimeTopologyServiceState {
  return {
    id: service.id,
    createdAt: service.createdAt?.trim() || undefined,
    worktreePath: service.worktreePath,
    cwd: service.cwd,
    label: service.label,
    launchCommandLine: service.launchCommandLine,
    tmuxTarget: service.tmuxTarget,
  };
}

export function serviceLabelForCommand(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return "shell";
  const first = trimmed.split(/\s+/)[0] ?? "service";
  return first.split("/").pop() ?? first;
}

export function createService(
  host: ServiceHost,
  commandLine: string,
  worktreePath?: string,
  opts?: { serviceId?: string },
): { serviceId: string } {
  const serviceId = opts?.serviceId ?? generateServiceId();
  const root = projectRootFor(host);
  const cwd = worktreePath ?? root;
  const shell = process.env.SHELL || "zsh";
  const trimmed = commandLine.trim();
  const launchScript = buildServiceLaunchScript(trimmed, shell);
  let projectRoot = root;
  try {
    projectRoot = findMainRepo(cwd);
  } catch {
    projectRoot = root;
  }
  const wrapped = trimmed
    ? wrapCommandWithShellIntegration({
        projectRoot,
        sessionId: serviceId,
        tool: "service",
        command: shell,
        args: ["-lc", launchScript],
        shellPath: shell,
      })
    : wrapInteractiveShellWithIntegration({
        projectRoot,
        sessionId: serviceId,
        tool: "service",
        shellPath: shell,
      });
  const command = wrapped.command;
  const args = wrapped.args;
  const label = serviceLabelForCommand(trimmed);
  const tmuxSession = host.tmuxRuntimeManager.ensureProjectSession(projectRoot);
  const shouldRenderPending = host.startedInDashboard && host.mode === "dashboard";
  if (shouldRenderPending) {
    host.setPendingDashboardServiceAction(serviceId, "creating", {
      serviceSeed: {
        id: serviceId,
        command: trimmed ? shell : "shell",
        args: trimmed ? ["-lc", trimmed] : ["-l"],
        createdAt: new Date().toISOString(),
        worktreePath,
        status: "running",
        active: false,
        label,
        optimistic: true,
      },
    });
  }
  try {
    const target = host.tmuxRuntimeManager.createWindow(tmuxSession.sessionName, label, cwd, command, args, {
      detached: true,
    });
    host.tmuxRuntimeManager.setWindowMetadata(target, {
      kind: "service",
      sessionId: serviceId,
      command: trimmed ? shell : "shell",
      args: trimmed ? ["-lc", trimmed] : ["-l"],
      toolConfigKey: "service",
      createdAt: new Date().toISOString(),
      worktreePath,
      label,
      launchCommandLine: trimmed,
    });
    upsertTopologyService(
      {
        id: serviceId,
        command: trimmed ? shell : "shell",
        args: trimmed ? ["-lc", trimmed] : ["-l"],
        launchCommandLine: trimmed,
        worktreePath,
        cwd,
        label,
        tmuxTarget: target,
      },
      "running",
    );
    host.tmuxRuntimeManager.applyManagedAgentWindowPolicy(target, "service");
    commitServiceState(host, {
      upsert: [
        {
          id: serviceId,
          createdAt: new Date().toISOString(),
          worktreePath,
          cwd,
          label,
          launchCommandLine: trimmed,
          tmuxTarget: target,
        },
      ],
    });
    host.preferDashboardEntrySelection("service", serviceId, worktreePath);
    host.settleDashboardCreatePending(serviceId, "service");
    return { serviceId };
  } catch (error) {
    if (shouldRenderPending) {
      host.setPendingDashboardServiceAction(serviceId, null);
    }
    throw error;
  }
}

export function stopService(host: ServiceHost, serviceId: string): { serviceId: string; status: "stopped" } {
  const projectRoot = projectRootFor(host);
  const tmuxSession = host.tmuxRuntimeManager.getProjectSession(projectRoot);
  const match = host.tmuxRuntimeManager.findManagedWindow(tmuxSession.sessionName, {
    sessionId: serviceId,
  });
  if (!match || match.metadata.kind !== "service") {
    throw new Error(`Service "${serviceId}" not found`);
  }
  markServiceUsed(host, serviceId);
  const cwd =
    host.tmuxRuntimeManager.displayMessage("#{pane_current_path}", match.target.windowId) ??
    match.metadata.worktreePath;
  host.offlineServices = [
    ...host.offlineServices.filter((service: ServiceState) => service.id !== serviceId),
    buildServiceStateFromMetadata(serviceId, match.metadata, {
      cwd,
    }),
  ];
  upsertTopologyService(
    serviceMetadataToTopologyState(serviceId, match.metadata, {
      cwd,
    }),
    "stopped",
  );
  suppressNextShellReports(projectRoot, serviceId, 1);
  try {
    host.tmuxRuntimeManager.killWindow(match.target);
  } catch {
    host.tmuxRuntimeManager.sendKey(match.target, "C-c");
  }
  commitServiceState(host);
  return { serviceId, status: "stopped" };
}

export function removeOfflineService(host: ServiceHost, serviceId: string): { serviceId: string; status: "removed" } {
  host.removedServiceIds?.add?.(serviceId);
  const offlineService = host.offlineServices.find((service: ServiceState) => service.id === serviceId);
  const existing = host.tmuxRuntimeManager.findManagedWindow(
    host.tmuxRuntimeManager.getProjectSession(projectRootFor(host)).sessionName,
    {
      sessionId: serviceId,
    },
  );
  if (existing && existing.metadata.kind === "service") {
    try {
      host.tmuxRuntimeManager.killWindow(existing.target);
    } catch {}
  } else if (offlineService?.tmuxTarget && host.tmuxRuntimeManager.hasWindow?.(offlineService.tmuxTarget)) {
    try {
      host.tmuxRuntimeManager.killWindow(offlineService.tmuxTarget);
    } catch {}
  }
  host.offlineServices = host.offlineServices.filter((service: ServiceState) => service.id !== serviceId);
  removeTopologyService(serviceId);
  commitServiceState(host, { removeIds: [serviceId] });
  return { serviceId, status: "removed" };
}

export function resumeOfflineService(
  host: ServiceHost,
  service: ServiceState,
): { serviceId: string; status: "running" } {
  const root = projectRootFor(host);
  const existing = host.tmuxRuntimeManager.findManagedWindow(
    host.tmuxRuntimeManager.getProjectSession(root).sessionName,
    {
      sessionId: service.id,
    },
  );
  if (existing && existing.metadata.kind === "service") {
    try {
      host.tmuxRuntimeManager.killWindow(existing.target);
    } catch {}
  }
  const cwd = service.worktreePath ?? root;
  const resumeCwd = service.cwd ?? cwd;
  const shell = process.env.SHELL || "zsh";
  const launchCommandLine = service.launchCommandLine?.trim() ?? "";
  const label = service.label ?? serviceLabelForCommand(launchCommandLine);
  const metadata = {
    kind: "service",
    sessionId: service.id,
    command: launchCommandLine ? shell : "shell",
    args: launchCommandLine ? ["-lc", launchCommandLine] : ["-l"],
    launchCommandLine,
    toolConfigKey: "service",
    createdAt: service.createdAt ?? new Date().toISOString(),
    worktreePath: service.worktreePath,
    label,
  };
  const launchScript = buildServiceLaunchScript(launchCommandLine, shell);
  let projectRoot = root;
  try {
    projectRoot = findMainRepo(cwd);
  } catch {
    projectRoot = root;
  }
  const wrapped = launchCommandLine
    ? wrapCommandWithShellIntegration({
        projectRoot,
        sessionId: service.id,
        tool: "service",
        command: shell,
        args: ["-lc", launchScript],
        shellPath: shell,
      })
    : wrapInteractiveShellWithIntegration({
        projectRoot,
        sessionId: service.id,
        tool: "service",
        shellPath: shell,
      });
  const tmuxSession = host.tmuxRuntimeManager.ensureProjectSession(projectRoot);
  const target: TmuxTarget = host.tmuxRuntimeManager.createWindow(
    tmuxSession.sessionName,
    label,
    resumeCwd,
    wrapped.command,
    wrapped.args,
    { detached: true },
  );
  host.tmuxRuntimeManager.setWindowMetadata(target, metadata);
  upsertTopologyService(
    {
      ...serviceStateToTopologyState(service),
      command: launchCommandLine ? shell : "shell",
      args: launchCommandLine ? ["-lc", launchCommandLine] : ["-l"],
      label,
      tmuxTarget: target,
    },
    "running",
  );
  host.tmuxRuntimeManager.applyManagedAgentWindowPolicy(target, "service");
  host.offlineServices = host.offlineServices.filter((entry: ServiceState) => entry.id !== service.id);
  markServiceUsed(host, service.id);
  commitServiceState(host, {
    upsert: [
      {
        id: service.id,
        createdAt: service.createdAt,
        worktreePath: service.worktreePath,
        cwd: resumeCwd,
        label,
        launchCommandLine,
        tmuxTarget: target,
      },
    ],
  });
  host.preferDashboardEntrySelection("service", service.id, service.worktreePath);
  return { serviceId: service.id, status: "running" };
}

export function resumeOfflineServiceById(
  host: ServiceHost,
  serviceId: string,
): { serviceId: string; status: "running" } {
  const service = host.offlineServices.find((entry: ServiceState) => entry.id === serviceId);
  if (service) {
    return resumeOfflineService(host, service);
  }
  const existing = host.tmuxRuntimeManager.findManagedWindow(
    host.tmuxRuntimeManager.getProjectSession(projectRootFor(host)).sessionName,
    {
      sessionId: serviceId,
    },
  );
  if (!existing || existing.metadata.kind !== "service") {
    throw new Error(`Service "${serviceId}" not found`);
  }
  if (host.tmuxRuntimeManager.isWindowAlive(existing.target)) {
    return { serviceId, status: "running" };
  }
  const restored = buildServiceStateFromMetadata(serviceId, existing.metadata);
  return resumeOfflineService(host, restored);
}
