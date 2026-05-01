import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { findMainRepo } from "../worktree.js";
import { getStatePath } from "../paths.js";
import type { ServiceState } from "./index.js";
import { wrapCommandWithShellIntegration, wrapInteractiveShellWithIntegration } from "../shell-hooks.js";

type ServiceHost = any;

function getServiceLaunchCommandLine(metadata: { command?: string; args?: string[] }): string {
  return metadata.command === "shell" ? "" : metadata.args?.[0] === "-lc" ? (metadata.args[1] ?? "") : "";
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

function buildServiceStateFromMetadata(
  serviceId: string,
  metadata: {
    command?: string;
    args?: string[];
    createdAt?: string;
    worktreePath?: string;
    label?: string;
  },
): ServiceState {
  return {
    id: serviceId,
    createdAt: metadata.createdAt,
    worktreePath: metadata.worktreePath,
    label: metadata.label,
    launchCommandLine: getServiceLaunchCommandLine(metadata),
  };
}

export function serviceLabelForCommand(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return "shell";
  const first = trimmed.split(/\s+/)[0] ?? "service";
  return first.split("/").pop() ?? first;
}

export function createService(host: ServiceHost, commandLine: string, worktreePath?: string): { serviceId: string } {
  const serviceId = `service-${randomUUID().slice(0, 8)}`;
  const cwd = worktreePath ?? process.cwd();
  const shell = process.env.SHELL || "zsh";
  const trimmed = commandLine.trim();
  const launchScript = buildServiceLaunchScript(trimmed, shell);
  let projectRoot = process.cwd();
  try {
    projectRoot = findMainRepo(cwd);
  } catch {
    projectRoot = process.cwd();
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
  const tmuxSession = host.tmuxRuntimeManager.ensureProjectSession(process.cwd());
  const shouldRenderPending = host.startedInDashboard && host.mode === "dashboard";
  if (shouldRenderPending) {
    host.setPendingDashboardSessionAction(serviceId, "creating", {
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
    });
    host.tmuxRuntimeManager.applyManagedAgentWindowPolicy(target, "service");
    host.saveState();
    host.invalidateDesktopStateSnapshot();
    host.refreshLocalDashboardModel();
    host.updateWorktreeSessions();
    host.preferDashboardEntrySelection("service", serviceId, worktreePath);
    host.settleDashboardCreatePending(serviceId);
    return { serviceId };
  } catch (error) {
    if (shouldRenderPending) {
      host.setPendingDashboardSessionAction(serviceId, null);
    }
    throw error;
  }
}

export function stopService(host: ServiceHost, serviceId: string): { serviceId: string; status: "stopped" } {
  const tmuxSession = host.tmuxRuntimeManager.getProjectSession(process.cwd());
  const match = host.tmuxRuntimeManager.findManagedWindow(tmuxSession.sessionName, {
    sessionId: serviceId,
  });
  if (!match || match.metadata.kind !== "service") {
    throw new Error(`Service "${serviceId}" not found`);
  }
  host.offlineServices = [
    ...host.offlineServices.filter((service: ServiceState) => service.id !== serviceId),
    buildServiceStateFromMetadata(serviceId, match.metadata),
  ];
  host.tmuxRuntimeManager.killWindow(match.target);
  host.saveState();
  host.invalidateDesktopStateSnapshot();
  host.refreshLocalDashboardModel();
  host.adjustAfterRemove(host.dashboardWorktreeGroupsCache.length > 0);
  return { serviceId, status: "stopped" };
}

export function removeOfflineService(host: ServiceHost, serviceId: string): { serviceId: string; status: "removed" } {
  const existing = host.tmuxRuntimeManager.findManagedWindow(
    host.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
    {
      sessionId: serviceId,
    },
  );
  if (existing && existing.metadata.kind === "service") {
    try {
      host.tmuxRuntimeManager.killWindow(existing.target);
    } catch {}
  }
  host.offlineServices = host.offlineServices.filter((service: ServiceState) => service.id !== serviceId);
  const statePath = getStatePath();
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as { services?: ServiceState[] };
      state.services = (state.services ?? []).filter((service) => service.id !== serviceId);
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    } catch {}
  }
  host.saveState();
  host.invalidateDesktopStateSnapshot();
  host.refreshLocalDashboardModel();
  host.adjustAfterRemove(host.dashboardWorktreeGroupsCache.length > 0);
  return { serviceId, status: "removed" };
}

export function resumeOfflineService(
  host: ServiceHost,
  service: ServiceState,
): { serviceId: string; status: "running" } {
  const existing = host.tmuxRuntimeManager.findManagedWindow(
    host.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
    {
      sessionId: service.id,
    },
  );
  if (existing && existing.metadata.kind === "service") {
    if (host.tmuxRuntimeManager.isWindowAlive(existing.target)) {
      host.offlineServices = host.offlineServices.filter((entry: ServiceState) => entry.id !== service.id);
      host.saveState();
      host.invalidateDesktopStateSnapshot();
      host.refreshLocalDashboardModel();
      return { serviceId: service.id, status: "running" };
    }
    try {
      host.tmuxRuntimeManager.killWindow(existing.target);
    } catch {}
  }
  const cwd = service.worktreePath ?? process.cwd();
  const shell = process.env.SHELL || "zsh";
  const launchCommandLine = service.launchCommandLine?.trim() ?? "";
  const launchScript = buildServiceLaunchScript(launchCommandLine, shell);
  let projectRoot = process.cwd();
  try {
    projectRoot = findMainRepo(cwd);
  } catch {
    projectRoot = process.cwd();
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
  const command = wrapped.command;
  const args = wrapped.args;
  const label = service.label ?? serviceLabelForCommand(launchCommandLine);
  const tmuxSession = host.tmuxRuntimeManager.ensureProjectSession(process.cwd());
  const target = host.tmuxRuntimeManager.createWindow(tmuxSession.sessionName, label, cwd, command, args, {
    detached: true,
  });
  host.tmuxRuntimeManager.setWindowMetadata(target, {
    kind: "service",
    sessionId: service.id,
    command: launchCommandLine ? shell : "shell",
    args: launchCommandLine ? ["-lc", launchCommandLine] : ["-l"],
    toolConfigKey: "service",
    createdAt: service.createdAt ?? new Date().toISOString(),
    worktreePath: service.worktreePath,
    label,
  });
  host.tmuxRuntimeManager.applyManagedAgentWindowPolicy(target, "service");
  host.offlineServices = host.offlineServices.filter((entry: ServiceState) => entry.id !== service.id);
  host.saveState();
  host.invalidateDesktopStateSnapshot();
  host.refreshLocalDashboardModel();
  host.updateWorktreeSessions();
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
    host.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
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
