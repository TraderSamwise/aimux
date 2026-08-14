import type { DaemonProject } from "@/lib/api";
import type { DesktopSession, DesktopState } from "@/lib/desktop-state";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import type { ActiveSharedSession, MonitorSettings } from "@/stores/settings";

export interface MonitorProjectTarget {
  kind: "project-agent";
  id: string;
  projectPath: string;
  projectName: string;
  sessionId: string;
  sessionLabel: string;
  status: DesktopSession["status"];
  endpoint: ServiceEndpoint;
}

export interface MonitorSharedTarget {
  kind: "shared-chat";
  id: string;
  ownerUserId: string;
  shareId: string;
  projectRoot: string;
  projectName: string;
  sessionId: string;
  sessionLabel: string;
  endpoint: ServiceEndpoint;
}

export type MonitorTarget = MonitorProjectTarget | MonitorSharedTarget;

const ACTIVE_SESSION_STATUSES = new Set<DesktopSession["status"]>(["running", "idle", "waiting"]);

export function monitorSessionTargetsForProject(
  project: DaemonProject,
  state: DesktopState | null | undefined,
): MonitorProjectTarget[] {
  const endpoint = getProjectServiceEndpoint(project);
  if (!endpoint || !state) return [];
  return state.sessions
    .filter((session) => ACTIVE_SESSION_STATUSES.has(session.status))
    .filter((session) => !session.overseer)
    .map((session) => ({
      kind: "project-agent",
      id: monitorProjectTargetId(project.path, session.id),
      projectPath: project.path,
      projectName: project.name,
      sessionId: session.id,
      sessionLabel: session.label || session.id,
      status: session.status,
      endpoint,
    }));
}

export function monitorSharedTargets(
  shares: readonly ActiveSharedSession[],
): MonitorSharedTarget[] {
  return shares.map((share) => ({
    kind: "shared-chat",
    id: monitorSharedTargetId(share.ownerUserId, share.shareId),
    ownerUserId: share.ownerUserId,
    shareId: share.shareId,
    projectRoot: share.projectRoot,
    projectName: projectNameFromRoot(share.projectRoot),
    sessionId: share.sessionId,
    sessionLabel: share.sessionId,
    endpoint: share.serviceEndpoint,
  }));
}

export function targetMatchesSettings(target: MonitorTarget, settings: MonitorSettings): boolean {
  if (target.kind !== settings.targetKind || target.sessionId !== settings.sessionId) return false;
  if (target.kind === "project-agent") return target.projectPath === settings.projectPath;
  return target.ownerUserId === settings.shareOwnerUserId && target.shareId === settings.shareId;
}

export function monitorTargetLabel(target: MonitorTarget | null | undefined): string {
  if (!target) return "Choose a destination before starting.";
  if (target.kind === "shared-chat") return `${target.projectName} shared chat`;
  return `${target.projectName} / ${target.sessionLabel}`;
}

export function monitorProjectTargetId(projectPath: string, sessionId: string): string {
  return `project:${projectPath}:${sessionId}`;
}

export function monitorSharedTargetId(ownerUserId: string, shareId: string): string {
  return `shared:${ownerUserId}:${shareId}`;
}

function projectNameFromRoot(projectRoot: string): string {
  return projectRoot.split(/[\\/]/).filter(Boolean).pop() || projectRoot || "Shared chat";
}
