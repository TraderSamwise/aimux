// Typed HTTP wrappers for the aimux daemon + per-project metadata servers.
//
// Two surfaces:
//  - daemon routes (lives at getDaemonUrl()) — listing/managing projects
//  - project routes (lives at getServiceUrl(endpoint)) — interacting with a project's
//    sessions, history, plans, etc.
//
// The Authorization: Bearer header is conditionally attached when opts.token is set.
// The local daemon doesn't validate it today, but the contract is in place for
// hosted/Clerk-enabled deployments.

import { getDaemonUrl, getServiceUrl, type ServiceEndpoint } from "@/lib/daemon-url";
import { env } from "@/lib/env";
import type { RelayTransport } from "@/lib/relay-transport";
import type { DesktopState } from "@/lib/desktop-state";
import type { ParsedAgentOutput } from "@/lib/events";
import {
  PROJECT_API_ROUTES,
  type TeamConfigResponse,
  type ActiveWindowRequest,
  type AgentListResponse,
  type AgentLoopInput,
  type AgentLoopResponse,
  type AgentOverseerInput,
  type AgentOverseerResponse,
  type AgentOutputStreamInput,
  type AgentSessionInput,
  type ControlActionResponse,
  type CreateServiceInput,
  type CreateServiceResponse,
  type CreateTeammateInput,
  type CreateTeammateResponse,
  type CreateTeammateTaskInput,
  type CreateTeammateTaskResponse,
  type CreateWorktreeInput,
  type CreateWorktreeResponse,
  type ForkAgentInput,
  type ForkAgentResponse,
  type CoordinationWorklistResponse,
  type DeleteWorktreeResponse,
  type GraveyardCleanupInput,
  type GraveyardCleanupResponse,
  type GraveyardResponse,
  type GraveyardWorktreeResponse,
  type LivePaneAttachRequest,
  type LivePaneAttachResponse,
  type LivePaneInputResponse,
  type LivePaneOutputResponse,
  type LivePaneResizeResponse,
  type LibraryResponse,
  type InteractionStreamEventName,
  type InteractionPendingResponse,
  type InteractionRespondInput,
  type InteractionRespondResponse,
  type KillAgentResponse,
  type MigrateAgentInput,
  type MigrateAgentResponse,
  type NotificationsResponse,
  type NotificationClearResponse,
  type NotificationMutationInput,
  type NotificationReadResponse,
  type FocusWindowRequest,
  type OpenDashboardRequest,
  type OpenNotificationTargetRequest,
  type OrchestrationRouteMode,
  type OrchestrationRouteOptionsResponse,
  type OperationFailuresClearInput,
  type OperationFailuresClearResponse,
  type ProjectDiagnosticsResponse,
  type ProjectHealthResponse,
  type ProjectObservabilityResponse,
  type ProjectTopologyResponse,
  type RenameAgentInput,
  type RenameAgentResponse,
  type RemoveServiceResponse,
  type RemoveWorktreeResponse,
  type ResumeAgentResponse,
  type ResumeServiceResponse,
  type ResurrectAgentResponse,
  type ResurrectWorktreeResponse,
  type HandoffSendInput,
  type SpawnAgentInput,
  type SpawnAgentResponse,
  type StatuslineRefreshInput,
  type StatuslineRefreshResponse,
  type StopAgentResponse,
  type StopServiceResponse,
  type SwitchableAgentsInput,
  type SwitchableAgentsResponse,
  type SwitchAgentRequest,
  type TaskAssignInput,
  type TaskDetailResponse,
  type TaskLifecycleInput,
  type TaskListResponse,
  type TeammateLifecycleResponse,
  type TeammateListResponse,
  type ThreadLifecycleInput,
  type ThreadMarkSeenInput,
  type ThreadMarkSeenResponse,
  type ThreadOpenInput,
  type ThreadOpenResponse,
  type ThreadSendInput,
  type ThreadSendResponse,
  type ThreadStatusInput,
  type ThreadStatusResponse,
  type ThreadSummaryResponse,
  type WorkflowMutationResponse,
  type WorktreesResponse,
  type WorktreePathInput,
} from "../../src/project-api-contract";

export type {
  CoordinationBucket,
  CoordinationReachability,
  CoordinationWorklistItem,
  CoordinationWorklistResponse,
  CoordinationWorklistType,
  GraveyardEntryResponse,
  GraveyardResponse,
  LibraryDocument,
  LibraryEntry,
  LibraryResponse,
  NotificationRecord,
  NotificationsResponse,
  ProjectObservabilityResponse,
  ProjectTopologyResponse,
  TeammateListResponse,
  ProjectWorktreeSummary,
  TaskDetailResponse,
  TaskListResponse,
  TaskSummaryResponse,
  ThreadSummaryResponse,
  WorktreeGraveyardEntryResponse,
  WorktreesResponse,
} from "../../src/project-api-contract";

let _relay: RelayTransport | null = null;
export function setApiRelay(relay: RelayTransport | null): void {
  _relay = relay;
}

export function getApiRelay(): RelayTransport | null {
  return _relay;
}

export interface ApiOpts {
  token?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_API_TIMEOUT_MS = 10_000;

function requestSignal(opts?: ApiOpts): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS);
  const timeout = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const abortFromCaller = () => controller.abort(opts?.signal?.reason);
  if (opts?.signal?.aborted) abortFromCaller();
  else opts?.signal?.addEventListener("abort", abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function callJson<T>(url: string, init: RequestInit, opts?: ApiOpts): Promise<T> {
  const headers = new Headers(init.headers);
  if (opts?.token) headers.set("Authorization", `Bearer ${opts.token}`);
  if (!headers.has("content-type") && init.body !== undefined && init.body !== null) {
    headers.set("content-type", "application/json");
  }
  const { signal, cleanup } = requestSignal(opts);
  try {
    const res = await fetch(url, { ...init, headers, signal });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, body, `${msg} (${url})`);
    }
    const body = await res.json();
    if (
      body &&
      typeof body === "object" &&
      "ok" in body &&
      (body as { ok?: unknown }).ok === false
    ) {
      const message =
        "error" in body ? String((body as { error: unknown }).error) : "Request failed";
      throw new ApiError(res.status, body, `${message} (${url})`);
    }
    return body as T;
  } finally {
    cleanup();
  }
}

async function callDaemonViaRelay<T>(method: string, path: string, body?: unknown): Promise<T> {
  const relay = _relay;
  if (!relay) throw new ApiError(0, null, "Relay not connected");
  const result = await relay.request(method, path, body);
  if (result.status >= 400) {
    const b = result.body as { error?: string } | null;
    throw new ApiError(result.status, result.body, b?.error ?? `HTTP ${result.status}`);
  }
  return result.body as T;
}

async function callServiceViaRelay<T>(
  endpoint: ServiceEndpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const proxyPath = `/proxy/${endpoint.host}/${endpoint.port}${path}`;
  return callDaemonViaRelay<T>(method, proxyPath, body);
}

export function shouldRouteViaRelay(): boolean {
  return _relay !== null || env.AIMUX_CONNECTION_MODE === "relay";
}

async function callProjectJson<T>(
  endpoint: ServiceEndpoint,
  method: string,
  path: string,
  opts?: ApiOpts,
  body?: unknown,
): Promise<T> {
  if (shouldRouteViaRelay()) return callServiceViaRelay<T>(endpoint, method, path, body);
  return callJson<T>(
    `${getServiceUrl(endpoint)}${path}`,
    {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    opts,
  );
}

function projectProxyPath(endpoint: ServiceEndpoint, path: string): string {
  return `/proxy/${endpoint.host}/${endpoint.port}${path}`;
}

function queryPath(
  path: string,
  params: Record<string, string | number | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return `${path}${qs ? `?${qs}` : ""}`;
}

export interface ProjectStreamRoute {
  path: string;
  directUrl: string;
  relayPath: string;
  headers: Record<string, string>;
}

function projectStreamRoute(
  endpoint: ServiceEndpoint,
  path: string,
  opts?: ApiOpts,
): ProjectStreamRoute {
  const headers: Record<string, string> = {};
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  return {
    path,
    directUrl: `${getServiceUrl(endpoint)}${path}`,
    relayPath: projectProxyPath(endpoint, path),
    headers,
  };
}

// ── Daemon (port 43190) ───────────────────────────────────────────────────

export interface DaemonHealth {
  ok: boolean;
  pid: number;
  port: number;
}

export interface DaemonProject {
  id: string;
  name: string;
  path: string;
  lastSeen?: string;
  dashboardSessionName: string;
  service: unknown | null;
  serviceAlive: boolean;
  serviceEndpoint: ServiceEndpoint | null;
}

export async function getDaemonHealth(opts?: ApiOpts): Promise<DaemonHealth> {
  if (shouldRouteViaRelay()) return callDaemonViaRelay<DaemonHealth>("GET", "/health");
  return callJson<DaemonHealth>(`${getDaemonUrl()}/health`, { method: "GET" }, opts);
}

export async function listProjects(opts?: ApiOpts): Promise<DaemonProject[]> {
  if (shouldRouteViaRelay()) {
    const data = await callDaemonViaRelay<{ ok: boolean; projects: DaemonProject[] }>(
      "GET",
      "/projects",
    );
    return data.projects;
  }
  const data = await callJson<{ ok: boolean; projects: DaemonProject[] }>(
    `${getDaemonUrl()}/projects`,
    { method: "GET" },
    opts,
  );
  return data.projects;
}

export interface EnsureProjectResponse {
  ok: boolean;
  project?: DaemonProject;
  [k: string]: unknown;
}

export async function ensureProject(
  projectRoot: string,
  opts?: ApiOpts,
): Promise<EnsureProjectResponse> {
  if (shouldRouteViaRelay())
    return callDaemonViaRelay<EnsureProjectResponse>("POST", "/projects/ensure", { projectRoot });
  return callJson<EnsureProjectResponse>(
    `${getDaemonUrl()}/projects/ensure`,
    { method: "POST", body: JSON.stringify({ projectRoot }) },
    opts,
  );
}

// ── Project routes (per-project metadata server) ─────────────────────────

export interface ProjectStateResponse {
  ok: boolean;
  [k: string]: unknown;
}

export async function getProjectState(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<ProjectStateResponse> {
  return callProjectJson<ProjectStateResponse>(endpoint, "GET", PROJECT_API_ROUTES.state, opts);
}

export async function getProjectHealth(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<ProjectHealthResponse> {
  return callProjectJson<ProjectHealthResponse>(endpoint, "GET", PROJECT_API_ROUTES.health, opts);
}

export async function getProjectDiagnostics(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<ProjectDiagnosticsResponse> {
  return callProjectJson<ProjectDiagnosticsResponse>(
    endpoint,
    "GET",
    PROJECT_API_ROUTES.diagnostics,
    opts,
  );
}

export async function getTeamConfig(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<TeamConfigResponse> {
  return callProjectJson<TeamConfigResponse>(endpoint, "GET", PROJECT_API_ROUTES.team.config, opts);
}

export async function initTeamConfig(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<TeamConfigResponse> {
  return callProjectJson<TeamConfigResponse>(endpoint, "POST", PROJECT_API_ROUTES.team.init, opts, {});
}

export async function addTeamRole(
  endpoint: ServiceEndpoint,
  input: { role: string; description?: string; reviewedBy?: string; canEdit?: boolean },
  opts?: ApiOpts,
): Promise<TeamConfigResponse> {
  return callProjectJson<TeamConfigResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.team.addRole,
    opts,
    input,
  );
}

export async function removeTeamRole(
  endpoint: ServiceEndpoint,
  role: string,
  opts?: ApiOpts,
): Promise<TeamConfigResponse> {
  return callProjectJson<TeamConfigResponse>(endpoint, "POST", PROJECT_API_ROUTES.team.removeRole, opts, { role });
}

export async function setDefaultTeamRole(
  endpoint: ServiceEndpoint,
  role: string,
  opts?: ApiOpts,
): Promise<TeamConfigResponse> {
  return callProjectJson<TeamConfigResponse>(endpoint, "POST", PROJECT_API_ROUTES.team.defaultRole, opts, { role });
}

export type AgentOutputResponse = LivePaneOutputResponse & { parsed?: ParsedAgentOutput };

export async function getLivePaneOutput(
  endpoint: ServiceEndpoint,
  sessionId: string,
  startLine?: number,
  opts?: ApiOpts,
): Promise<AgentOutputResponse> {
  const params = new URLSearchParams({ sessionId });
  if (startLine !== undefined) params.set("startLine", String(startLine));
  return callProjectJson<AgentOutputResponse>(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.livePane.output}?${params.toString()}`,
    opts,
  );
}

export const getAgentOutput = getLivePaneOutput;

export function getAgentOutputStreamRoute(
  endpoint: ServiceEndpoint,
  input: AgentOutputStreamInput,
  opts?: ApiOpts,
): ProjectStreamRoute {
  return projectStreamRoute(
    endpoint,
    queryPath(PROJECT_API_ROUTES.agents.outputStream, {
      sessionId: input.sessionId,
      startLine: input.startLine,
      intervalMs: input.intervalMs,
    }),
    opts,
  );
}

export type SendAgentInputResponse = LivePaneInputResponse;

export interface SendAgentInputOptions extends ApiOpts {
  attachmentIds?: string[];
}

export async function sendLivePaneInput(
  endpoint: ServiceEndpoint,
  sessionId: string,
  text: string,
  opts?: SendAgentInputOptions,
): Promise<SendAgentInputResponse> {
  return callProjectJson<SendAgentInputResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.livePane.input,
    opts,
    {
      sessionId,
      text,
      ...(opts?.attachmentIds?.length ? { attachmentIds: opts.attachmentIds } : {}),
    },
  );
}

export const sendAgentInput = sendLivePaneInput;

export async function interruptLivePane(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean; sessionId: string }> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.livePane.interrupt, opts, {
    sessionId,
  });
}

export async function resizeLivePane(
  endpoint: ServiceEndpoint,
  sessionId: string,
  cols: number,
  rows: number,
  opts?: ApiOpts,
): Promise<LivePaneResizeResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.livePane.resize, opts, {
    sessionId,
    cols,
    rows,
  });
}

export async function attachLivePane(
  endpoint: ServiceEndpoint,
  input: LivePaneAttachRequest,
  opts?: ApiOpts,
): Promise<LivePaneAttachResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.livePane.attach, opts, input);
}

export async function listAgents(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<AgentListResponse> {
  return callProjectJson<AgentListResponse>(endpoint, "GET", PROJECT_API_ROUTES.agents.list, opts);
}

export async function spawnAgent(
  endpoint: ServiceEndpoint,
  input: SpawnAgentInput,
  opts?: ApiOpts,
): Promise<SpawnAgentResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.spawn, opts, input);
}

export async function forkAgent(
  endpoint: ServiceEndpoint,
  input: ForkAgentInput,
  opts?: ApiOpts,
): Promise<ForkAgentResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.fork, opts, input);
}

export async function stopAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<StopAgentResponse> {
  const input: AgentSessionInput = { sessionId };
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.stop, opts, input);
}

export async function resumeAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<ResumeAgentResponse> {
  const input: AgentSessionInput = { sessionId };
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.resume, opts, input);
}

export async function killAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<KillAgentResponse> {
  const input: AgentSessionInput = { sessionId };
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.kill, opts, input);
}

export async function renameAgent(
  endpoint: ServiceEndpoint,
  input: RenameAgentInput,
  opts?: ApiOpts,
): Promise<RenameAgentResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.rename, opts, input);
}

export async function migrateAgent(
  endpoint: ServiceEndpoint,
  input: MigrateAgentInput,
  opts?: ApiOpts,
): Promise<MigrateAgentResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.migrate, opts, input);
}

export async function setAgentLoop(
  endpoint: ServiceEndpoint,
  input: AgentLoopInput,
  opts?: ApiOpts,
): Promise<AgentLoopResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.loop, opts, input);
}

export async function setAgentOverseer(
  endpoint: ServiceEndpoint,
  input: AgentOverseerInput,
  opts?: ApiOpts,
): Promise<AgentOverseerResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.overseer, opts, input);
}

export async function listTeammates(
  endpoint: ServiceEndpoint,
  parentSessionId: string,
  opts?: ApiOpts,
): Promise<TeammateListResponse> {
  const path = queryPath(PROJECT_API_ROUTES.agents.teammates, { parentSessionId });
  return callProjectJson(endpoint, "GET", path, opts);
}

export async function createTeammate(
  endpoint: ServiceEndpoint,
  input: CreateTeammateInput,
  opts?: ApiOpts,
): Promise<CreateTeammateResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.createTeammate, opts, input);
}

export async function createTeammateTask(
  endpoint: ServiceEndpoint,
  input: CreateTeammateTaskInput,
  opts?: ApiOpts,
): Promise<CreateTeammateTaskResponse> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.agents.createTeammateTask,
    opts,
    input,
  );
}

async function teammateLifecycle(
  endpoint: ServiceEndpoint,
  path: string,
  parentSessionId: string,
  teammateSessionId: string,
  opts?: ApiOpts,
): Promise<TeammateLifecycleResponse> {
  return callProjectJson(endpoint, "POST", path, opts, { parentSessionId, teammateSessionId });
}

export async function stopTeammate(
  endpoint: ServiceEndpoint,
  parentSessionId: string,
  teammateSessionId: string,
  opts?: ApiOpts,
): Promise<TeammateLifecycleResponse> {
  return teammateLifecycle(
    endpoint,
    PROJECT_API_ROUTES.agents.stopTeammate,
    parentSessionId,
    teammateSessionId,
    opts,
  );
}

export async function resumeTeammate(
  endpoint: ServiceEndpoint,
  parentSessionId: string,
  teammateSessionId: string,
  opts?: ApiOpts,
): Promise<TeammateLifecycleResponse> {
  return teammateLifecycle(
    endpoint,
    PROJECT_API_ROUTES.agents.resumeTeammate,
    parentSessionId,
    teammateSessionId,
    opts,
  );
}

export async function killTeammate(
  endpoint: ServiceEndpoint,
  parentSessionId: string,
  teammateSessionId: string,
  opts?: ApiOpts,
): Promise<TeammateLifecycleResponse> {
  return teammateLifecycle(
    endpoint,
    PROJECT_API_ROUTES.agents.killTeammate,
    parentSessionId,
    teammateSessionId,
    opts,
  );
}

export async function resurrectTeammate(
  endpoint: ServiceEndpoint,
  parentSessionId: string,
  teammateSessionId: string,
  opts?: ApiOpts,
): Promise<TeammateLifecycleResponse> {
  return teammateLifecycle(
    endpoint,
    PROJECT_API_ROUTES.agents.resurrectTeammate,
    parentSessionId,
    teammateSessionId,
    opts,
  );
}

export async function listSwitchableAgents(
  endpoint: ServiceEndpoint,
  input: SwitchableAgentsInput = {},
  opts?: ApiOpts,
): Promise<SwitchableAgentsResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return callProjectJson(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.controls.switchableAgents}${query ? `?${query}` : ""}`,
    opts,
  );
}

export async function listPendingInteractions(
  endpoint: ServiceEndpoint,
  sessionId?: string,
  opts?: ApiOpts,
): Promise<InteractionPendingResponse> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return callProjectJson(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.agents.interactionPending}${query}`,
    opts,
  );
}

export async function respondToInteraction(
  endpoint: ServiceEndpoint,
  input: InteractionRespondInput,
  opts?: ApiOpts,
): Promise<InteractionRespondResponse> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.agents.interactionRespond,
    opts,
    input,
  );
}

export function getInteractionStreamRoute(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): ProjectStreamRoute & { eventTypes: InteractionStreamEventName[] } {
  return {
    ...projectStreamRoute(endpoint, PROJECT_API_ROUTES.agents.interactionStream, opts),
    eventTypes: ["ready", "interaction"],
  };
}

export async function openDashboard(
  endpoint: ServiceEndpoint,
  input: OpenDashboardRequest = {},
  opts?: ApiOpts,
): Promise<ControlActionResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.controls.openDashboard, opts, {
    focus: false,
    ...input,
  });
}

export async function openNotificationTarget(
  endpoint: ServiceEndpoint,
  input: OpenNotificationTargetRequest,
  opts?: ApiOpts,
): Promise<ControlActionResponse> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.controls.openNotificationTarget,
    opts,
    {
      focus: false,
      ...input,
    },
  );
}

export async function focusWindow(
  endpoint: ServiceEndpoint,
  input: FocusWindowRequest,
  opts?: ApiOpts,
): Promise<ControlActionResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.controls.focusWindow, opts, {
    focus: false,
    ...input,
  });
}

export async function markActiveWindow(
  endpoint: ServiceEndpoint,
  input: ActiveWindowRequest,
  opts?: ApiOpts,
): Promise<ControlActionResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.controls.activeWindow, opts, input);
}

export async function switchNextAgent(
  endpoint: ServiceEndpoint,
  input: SwitchAgentRequest = {},
  opts?: ApiOpts,
): Promise<ControlActionResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.controls.switchNext, opts, {
    focus: false,
    ...input,
  });
}

export async function switchPrevAgent(
  endpoint: ServiceEndpoint,
  input: SwitchAgentRequest = {},
  opts?: ApiOpts,
): Promise<ControlActionResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.controls.switchPrev, opts, {
    focus: false,
    ...input,
  });
}

export async function switchAttentionAgent(
  endpoint: ServiceEndpoint,
  input: SwitchAgentRequest = {},
  opts?: ApiOpts,
): Promise<ControlActionResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.controls.switchAttention, opts, {
    focus: false,
    ...input,
  });
}

export interface UploadImageAttachmentInput {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface UploadImageAttachmentResponse {
  ok: boolean;
  attachment: {
    id: string;
    kind: "image";
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
    source: "path" | "upload";
    contentUrl: string;
  };
}

export async function uploadImageAttachment(
  endpoint: ServiceEndpoint,
  input: UploadImageAttachmentInput,
  opts?: ApiOpts,
): Promise<UploadImageAttachmentResponse> {
  return callProjectJson<UploadImageAttachmentResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.attachments,
    opts,
    {
      kind: "image",
      filename: input.filename,
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
    },
  );
}

// ── Relay sharing ────────────────────────────────────────────────────────

export interface ShareParticipant {
  userId: string;
  displayName: string;
  email?: string;
  role: "owner" | "guest";
  status: "active" | "removed";
  joinedAt: string;
  removedAt?: string;
  lastSeenAt?: string;
}

export interface ShareInvite {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked";
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedByUserId?: string;
  revokedAt?: string;
}

export interface SharedSessionSummary {
  id: string;
  ownerUserId: string;
  projectRoot: string;
  serviceEndpoint?: ServiceEndpoint;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  mode: "single" | "multi";
  participants: ShareParticipant[];
  invites: ShareInvite[];
}

export interface ShareInviteResponse {
  ok: boolean;
  emailDelivered: boolean;
  share: SharedSessionSummary;
  invite: ShareInvite;
  acceptUrl: string;
}

export interface ShareResponse {
  ok: boolean;
  share: SharedSessionSummary;
}

export interface SharesResponse {
  ok: boolean;
  shares: SharedSessionSummary[];
}

function relayHttpUrl(): string {
  const relayUrl = env.AIMUX_RELAY_URL;
  if (!relayUrl) throw new ApiError(0, null, "Relay sharing is not configured");
  return relayUrl.replace(/^ws/, "http").replace(/\/+$/, "");
}

export async function createShareInvite(
  projectRoot: string,
  sessionId: string,
  email: string,
  serviceEndpoint?: ServiceEndpoint | null,
  opts?: ApiOpts,
): Promise<ShareInviteResponse> {
  return callJson<ShareInviteResponse>(
    `${relayHttpUrl()}/shares/invite`,
    {
      method: "POST",
      body: JSON.stringify({ projectRoot, sessionId, email, serviceEndpoint }),
    },
    opts,
  );
}

export async function listShares(opts?: ApiOpts): Promise<SharesResponse> {
  return callJson<SharesResponse>(`${relayHttpUrl()}/shares`, {}, opts);
}

export async function getShare(
  ownerUserId: string,
  shareId: string,
  opts?: ApiOpts,
): Promise<ShareResponse> {
  return callJson<ShareResponse>(
    `${relayHttpUrl()}/shares/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(shareId)}`,
    {},
    opts,
  );
}

export async function leaveShare(
  ownerUserId: string,
  shareId: string,
  opts?: ApiOpts,
): Promise<ShareResponse> {
  return callJson<ShareResponse>(
    `${relayHttpUrl()}/shares/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(shareId)}/leave`,
    { method: "POST" },
    opts,
  );
}

export async function removeShareParticipant(
  ownerUserId: string,
  shareId: string,
  participantUserId: string,
  opts?: ApiOpts,
): Promise<ShareResponse> {
  return callJson<ShareResponse>(
    `${relayHttpUrl()}/shares/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(shareId)}/participants/${encodeURIComponent(
      participantUserId,
    )}`,
    { method: "DELETE" },
    opts,
  );
}

export interface AcceptShareInviteResponse {
  ok: boolean;
  share: SharedSessionSummary;
  participant: ShareParticipant;
}

export async function acceptShareInvite(
  ownerUserId: string,
  token: string,
  opts?: ApiOpts,
): Promise<AcceptShareInviteResponse> {
  return callJson<AcceptShareInviteResponse>(
    `${relayHttpUrl()}/shares/invite/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(
      token,
    )}/accept`,
    { method: "POST" },
    opts,
  );
}

// ── Plans (Task 2 endpoints) ─────────────────────────────────────────────

export interface PlanResponse {
  ok: boolean;
  sessionId: string;
  content: string;
}

export async function getPlan(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<PlanResponse> {
  return callProjectJson<PlanResponse>(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.plans}/${encodeURIComponent(sessionId)}`,
    opts,
  );
}

export async function putPlan(
  endpoint: ServiceEndpoint,
  sessionId: string,
  content: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean; sessionId: string }> {
  return callProjectJson<{ ok: boolean; sessionId: string }>(
    endpoint,
    "PUT",
    `${PROJECT_API_ROUTES.plans}/${encodeURIComponent(sessionId)}`,
    opts,
    { content },
  );
}

// ── Desktop state (project → worktree → agents | services hierarchy) ────

export async function getDesktopState(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<DesktopState> {
  return callProjectJson<DesktopState>(endpoint, "GET", PROJECT_API_ROUTES.desktopState, opts);
}

// ── Notifications ────────────────────────────────────────────────────────

export async function listNotifications(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts & { unreadOnly?: boolean; sessionId?: string },
): Promise<NotificationsResponse> {
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set("unread", "1");
  if (opts?.sessionId) params.set("sessionId", opts.sessionId);
  const query = params.toString();
  return callProjectJson<NotificationsResponse>(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.notifications.list}${query ? `?${query}` : ""}`,
    opts,
  );
}

export async function markNotificationsRead(
  endpoint: ServiceEndpoint,
  input: NotificationMutationInput = {},
  opts?: ApiOpts,
): Promise<NotificationReadResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.notifications.read, opts, input);
}

export async function clearNotifications(
  endpoint: ServiceEndpoint,
  input: NotificationMutationInput = {},
  opts?: ApiOpts,
): Promise<NotificationClearResponse> {
  const response = await callProjectJson<{ ok: boolean; cleared?: number; updated?: number }>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.notifications.clear,
    opts,
    input,
  );
  return { ok: response.ok, cleared: response.cleared ?? response.updated ?? 0 };
}

export async function getOrchestrationRouteOptions(
  endpoint: ServiceEndpoint,
  input: { mode?: OrchestrationRouteMode; selectedSessionId?: string; worktreePath?: string } = {},
  opts?: ApiOpts,
): Promise<OrchestrationRouteOptionsResponse> {
  const params = new URLSearchParams();
  if (input.mode) params.set("mode", input.mode);
  if (input.selectedSessionId) params.set("selectedSessionId", input.selectedSessionId);
  if (input.worktreePath) params.set("worktreePath", input.worktreePath);
  const query = params.toString();
  return callProjectJson<OrchestrationRouteOptionsResponse>(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.orchestration.routes}${query ? `?${query}` : ""}`,
    opts,
  );
}

// ── Service actions ──────────────────────────────────────────────────────

export async function createService(
  endpoint: ServiceEndpoint,
  input: CreateServiceInput,
  opts?: ApiOpts,
): Promise<CreateServiceResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.services.create, opts, input);
}

export async function stopService(
  endpoint: ServiceEndpoint,
  serviceId: string,
  opts?: ApiOpts,
): Promise<StopServiceResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.services.stop, opts, { serviceId });
}

export async function resumeService(
  endpoint: ServiceEndpoint,
  serviceId: string,
  opts?: ApiOpts,
): Promise<ResumeServiceResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.services.resume, opts, { serviceId });
}

export async function removeService(
  endpoint: ServiceEndpoint,
  serviceId: string,
  opts?: ApiOpts,
): Promise<RemoveServiceResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.services.remove, opts, { serviceId });
}

// ── Worktree actions ─────────────────────────────────────────────────────

export async function createWorktree(
  endpoint: ServiceEndpoint,
  name: string,
  opts?: ApiOpts,
): Promise<CreateWorktreeResponse> {
  const input: CreateWorktreeInput = { name };
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.worktreeActions.create, opts, input);
}

export async function removeWorktree(
  endpoint: ServiceEndpoint,
  path: string,
  opts?: ApiOpts,
): Promise<RemoveWorktreeResponse> {
  const input: WorktreePathInput = { path };
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.worktreeActions.remove, opts, input);
}

export async function graveyardWorktree(
  endpoint: ServiceEndpoint,
  path: string,
  opts?: ApiOpts,
): Promise<GraveyardWorktreeResponse> {
  const input: WorktreePathInput = { path };
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.worktreeActions.graveyard,
    opts,
    input,
  );
}

// ── Worktrees, graveyard, threads ───────────────────────────────────────

export async function listWorktrees(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<WorktreesResponse> {
  return callProjectJson<WorktreesResponse>(endpoint, "GET", PROJECT_API_ROUTES.worktrees, opts);
}

export async function listGraveyard(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<GraveyardResponse> {
  return callProjectJson<GraveyardResponse>(endpoint, "GET", PROJECT_API_ROUTES.graveyard, opts);
}

export async function resurrectGraveyardAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<ResurrectAgentResponse> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.graveyardActions.resurrectAgent,
    opts,
    { sessionId },
  );
}

export async function resurrectGraveyardWorktree(
  endpoint: ServiceEndpoint,
  path: string,
  opts?: ApiOpts,
): Promise<ResurrectWorktreeResponse> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.graveyardActions.resurrectWorktree,
    opts,
    { path },
  );
}

export async function deleteGraveyardWorktree(
  endpoint: ServiceEndpoint,
  path: string,
  opts?: ApiOpts,
): Promise<DeleteWorktreeResponse> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.graveyardActions.deleteWorktree,
    opts,
    { path },
  );
}

export async function cleanupGraveyard(
  endpoint: ServiceEndpoint,
  input: GraveyardCleanupInput = {},
  opts?: ApiOpts,
): Promise<GraveyardCleanupResponse> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.graveyardActions.cleanup,
    opts,
    input,
  );
}

export async function listThreads(
  endpoint: ServiceEndpoint,
  sessionId?: string,
  opts?: ApiOpts,
): Promise<ThreadSummaryResponse[]> {
  const path = sessionId
    ? `${PROJECT_API_ROUTES.threads.list}?session=${encodeURIComponent(sessionId)}`
    : PROJECT_API_ROUTES.threads.list;
  return callProjectJson<ThreadSummaryResponse[]>(endpoint, "GET", path, opts);
}

export async function markThreadSeen(
  endpoint: ServiceEndpoint,
  input: ThreadMarkSeenInput,
  opts?: ApiOpts,
): Promise<ThreadMarkSeenResponse> {
  return callProjectJson<ThreadMarkSeenResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.threads.markSeen,
    opts,
    input,
  );
}

export async function openThread(
  endpoint: ServiceEndpoint,
  input: ThreadOpenInput,
  opts?: ApiOpts,
): Promise<ThreadOpenResponse> {
  return callProjectJson<ThreadOpenResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.threads.open,
    opts,
    input,
  );
}

export async function sendThreadMessage(
  endpoint: ServiceEndpoint,
  input: ThreadSendInput,
  opts?: ApiOpts,
): Promise<ThreadSendResponse> {
  return callProjectJson<ThreadSendResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.threads.send,
    opts,
    input,
  );
}

export async function updateThreadStatus(
  endpoint: ServiceEndpoint,
  input: ThreadStatusInput,
  opts?: ApiOpts,
): Promise<ThreadStatusResponse> {
  return callProjectJson<ThreadStatusResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.threads.status,
    opts,
    input,
  );
}

export async function sendHandoff(
  endpoint: ServiceEndpoint,
  input: HandoffSendInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.handoff.send,
    opts,
    input,
  );
}

export async function acceptHandoff(
  endpoint: ServiceEndpoint,
  input: ThreadLifecycleInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.handoff.accept,
    opts,
    input,
  );
}

export async function completeHandoff(
  endpoint: ServiceEndpoint,
  input: ThreadLifecycleInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.handoff.complete,
    opts,
    input,
  );
}

export async function assignTask(
  endpoint: ServiceEndpoint,
  input: TaskAssignInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.tasks.assign,
    opts,
    input,
  );
}

export async function acceptTask(
  endpoint: ServiceEndpoint,
  input: TaskLifecycleInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.tasks.accept,
    opts,
    input,
  );
}

export async function blockTask(
  endpoint: ServiceEndpoint,
  input: TaskLifecycleInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.tasks.block,
    opts,
    input,
  );
}

export async function completeTask(
  endpoint: ServiceEndpoint,
  input: TaskLifecycleInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.tasks.complete,
    opts,
    input,
  );
}

export async function reopenTask(
  endpoint: ServiceEndpoint,
  input: TaskLifecycleInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.tasks.reopen,
    opts,
    input,
  );
}

export async function approveReview(
  endpoint: ServiceEndpoint,
  input: TaskLifecycleInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.reviews.approve,
    opts,
    input,
  );
}

export async function requestReviewChanges(
  endpoint: ServiceEndpoint,
  input: TaskLifecycleInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.reviews.requestChanges,
    opts,
    input,
  );
}

export async function listTasks(
  endpoint: ServiceEndpoint,
  filters?: { sessionId?: string; status?: string },
  opts?: ApiOpts,
): Promise<TaskListResponse> {
  const params = new URLSearchParams();
  if (filters?.sessionId) params.set("session", filters.sessionId);
  if (filters?.status) params.set("status", filters.status);
  const query = params.toString();
  return callProjectJson<TaskListResponse>(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.tasks.list}${query ? `?${query}` : ""}`,
    opts,
  );
}

// ── Coordination worklist (reconciled "needs-you" inbox) ─────────────────

export async function getCoordinationWorklist(
  endpoint: ServiceEndpoint,
  participant = "user",
  opts?: ApiOpts,
): Promise<CoordinationWorklistResponse> {
  return callProjectJson<CoordinationWorklistResponse>(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.coordinationWorklist}?participant=${encodeURIComponent(participant)}`,
    opts,
  );
}

export async function getProjectObservability(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<ProjectObservabilityResponse> {
  return callProjectJson<ProjectObservabilityResponse>(
    endpoint,
    "GET",
    PROJECT_API_ROUTES.projectObservability,
    opts,
  );
}

export async function getProjectTopology(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<ProjectTopologyResponse> {
  return callProjectJson<ProjectTopologyResponse>(
    endpoint,
    "GET",
    PROJECT_API_ROUTES.topology,
    opts,
  );
}

export async function listProjectLibrary(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<LibraryResponse> {
  return callProjectJson<LibraryResponse>(endpoint, "GET", PROJECT_API_ROUTES.library, opts);
}

export async function refreshStatusline(
  endpoint: ServiceEndpoint,
  input: StatuslineRefreshInput = {},
  opts?: ApiOpts,
): Promise<StatuslineRefreshResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.statuslineRefresh, opts, input);
}

export async function clearOperationFailures(
  endpoint: ServiceEndpoint,
  input: OperationFailuresClearInput = {},
  opts?: ApiOpts,
): Promise<OperationFailuresClearResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.operationFailuresClear, opts, input);
}

export async function getTask(
  endpoint: ServiceEndpoint,
  taskId: string,
  opts?: ApiOpts,
): Promise<TaskDetailResponse> {
  return callProjectJson<TaskDetailResponse>(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.tasks.list}/${encodeURIComponent(taskId)}`,
    opts,
  );
}
