import { log } from "../debug.js";
import { requestJson } from "../http-client.js";
import { loadMetadataEndpointByProjectId } from "../metadata-store.js";
import { listRegisteredDesktopProjects } from "../project-scanner.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import type { ProjectServiceState } from "../daemon-state.js";

const PROJECT_ONLINE_AGENT_COUNT_CACHE_TTL_MS = 2_000;
const PROJECT_ONLINE_AGENT_COUNT_TIMEOUT_MS = 500;

export type ProjectsRouteProject = ReturnType<typeof listRegisteredDesktopProjects>[number] & {
  service: ProjectServiceState | null;
  serviceAlive: boolean;
  serviceEndpoint: ReturnType<typeof loadMetadataEndpointByProjectId>;
  onlineAgentCount?: number;
};

type ProjectRouteServiceEndpoint = ReturnType<typeof loadMetadataEndpointByProjectId>;
type ProjectOnlineAgentCountCacheEntry = { count: number | undefined; ts: number };
type ProjectDesktopStateSession = {
  status?: unknown;
  pendingAction?: unknown;
  overseer?: unknown;
  team?: { role?: unknown } | null;
};
type ProjectDesktopStateGroup = { sessions?: unknown };
type ProjectDesktopStatePayload = {
  sessions?: unknown;
  teammates?: unknown;
  worktreeGroups?: unknown;
};

function isProjectDesktopStateSession(value: unknown): value is ProjectDesktopStateSession {
  return Boolean(value && typeof value === "object");
}

function isDashboardHiddenProjectSession(session: ProjectDesktopStateSession): boolean {
  return session.overseer === true || session.team?.role === "overseer";
}

function isOnlineProjectSession(session: ProjectDesktopStateSession): boolean {
  if (isDashboardHiddenProjectSession(session)) return false;
  if (session.pendingAction) return true;
  return session.status !== "offline" && session.status !== "exited";
}

function countSessionsFromUnknown(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter(isProjectDesktopStateSession).filter(isOnlineProjectSession).length;
}

export function countOnlineDesktopAgents(state: ProjectDesktopStatePayload): number | undefined {
  if (Array.isArray(state.worktreeGroups)) {
    return state.worktreeGroups.reduce((total, group) => {
      const sessions = group && typeof group === "object" ? (group as ProjectDesktopStateGroup).sessions : undefined;
      return total + countSessionsFromUnknown(sessions);
    }, 0);
  }
  if (Array.isArray(state.sessions) || Array.isArray(state.teammates)) {
    return countSessionsFromUnknown(state.sessions) + countSessionsFromUnknown(state.teammates);
  }
  return undefined;
}

export function buildProjectsRouteProjects(input: {
  servicesById: Record<string, ProjectServiceState>;
  getActorState: (projectId: string) => ProjectServiceState | null;
  isProjectServiceLive: (entry: ProjectServiceState) => boolean;
}): ProjectsRouteProject[] {
  return listRegisteredDesktopProjects().map((project) => {
    const actorState = input.getActorState(project.id);
    const service = actorState ?? input.servicesById[project.id] ?? null;
    const serviceAlive = service ? input.isProjectServiceLive(service) : false;
    return {
      ...project,
      service: serviceAlive ? service : null,
      serviceAlive,
      serviceEndpoint: loadMetadataEndpointByProjectId(project.id),
    };
  });
}

export class ProjectOnlineAgentCountReader {
  private readonly cache = new Map<string, ProjectOnlineAgentCountCacheEntry>();

  async read(
    projectId: string,
    serviceAlive: boolean,
    endpoint: ProjectRouteServiceEndpoint,
  ): Promise<number | undefined> {
    if (!serviceAlive) {
      this.cache.delete(projectId);
      return 0;
    }
    if (!endpoint) return undefined;

    const now = Date.now();
    const cached = this.cache.get(projectId);
    if (cached && now - cached.ts < PROJECT_ONLINE_AGENT_COUNT_CACHE_TTL_MS) return cached.count;

    try {
      const { status, json } = await requestJson<ProjectDesktopStatePayload>(
        `http://${endpoint.host}:${endpoint.port}${PROJECT_API_ROUTES.desktopState}`,
        { method: "GET", timeoutMs: PROJECT_ONLINE_AGENT_COUNT_TIMEOUT_MS },
      );
      const count = status >= 200 && status < 300 ? countOnlineDesktopAgents(json) : undefined;
      this.cache.set(projectId, { count, ts: now });
      return count;
    } catch (error) {
      log.warn("project online agent count fetch failed", "daemon", {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.cache.set(projectId, { count: undefined, ts: now });
      return undefined;
    }
  }
}
