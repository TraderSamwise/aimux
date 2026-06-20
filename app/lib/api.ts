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
  type ActiveWindowRequest,
  type ControlActionResponse,
  type CreateServiceInput,
  type CreateServiceResponse,
  type CreateWorktreeInput,
  type CreateWorktreeResponse,
  type DeleteWorktreeResponse,
  type GraveyardWorktreeResponse,
  type LivePaneAttachRequest,
  type LivePaneAttachResponse,
  type LivePaneInputResponse,
  type LivePaneOutputResponse,
  type LivePaneResizeResponse,
  type NotificationClearResponse,
  type NotificationMutationInput,
  type NotificationReadResponse,
  type FocusWindowRequest,
  type OpenDashboardRequest,
  type OpenInboxRequest,
  type OpenNotificationTargetRequest,
  type RemoveServiceResponse,
  type RemoveWorktreeResponse,
  type ResumeServiceResponse,
  type ResurrectAgentResponse,
  type ResurrectWorktreeResponse,
  type StopServiceResponse,
  type SwitchAgentRequest,
  type WorktreePathInput,
} from "../../src/project-api-contract";

let _relay: RelayTransport | null = null;
export function setApiRelay(relay: RelayTransport | null): void {
  _relay = relay;
}

export interface ApiOpts {
  token?: string | null;
  signal?: AbortSignal;
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

async function callJson<T>(url: string, init: RequestInit, opts?: ApiOpts): Promise<T> {
  const headers = new Headers(init.headers);
  if (opts?.token) headers.set("Authorization", `Bearer ${opts.token}`);
  if (!headers.has("content-type") && init.body !== undefined && init.body !== null) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(url, { ...init, headers, signal: opts?.signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, body, `${msg} (${url})`);
  }
  return (await res.json()) as T;
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

function shouldRouteViaRelay(): boolean {
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

export async function openInbox(
  endpoint: ServiceEndpoint,
  input: OpenInboxRequest = {},
  opts?: ApiOpts,
): Promise<ControlActionResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.controls.openInbox, opts, {
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

export interface NotificationRecord {
  id: string;
  title: string;
  subtitle?: string;
  body: string;
  sessionId?: string;
  targetKey?: string;
  targetKind?: "session" | "generic";
  kind?: string;
  projectName?: string;
  projectRoot?: string;
  worktreePath?: string;
  worktreeName?: string;
  branch?: string;
  categoryLabel?: string;
  reasonLabel?: string;
  unread: boolean;
  cleared: boolean;
  createdAt: string;
  updatedAt: string;
  dedupeKey?: string;
  interaction?: {
    id: string;
    type: "permission" | "exit_plan" | "question" | "input";
    summary?: string;
    telemetry?: boolean;
    toolName?: string;
    toolInputJSON?: string;
  };
}

export interface NotificationsResponse {
  ok: boolean;
  notifications: NotificationRecord[];
  unreadCount: number;
}

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

export interface WorktreesResponse {
  ok: boolean;
  worktrees: DesktopState["worktrees"];
  [k: string]: unknown;
}

export interface GraveyardEntryResponse {
  id: string;
  tool?: string;
  label?: string;
  diedAt?: string;
  [k: string]: unknown;
}

export interface WorktreeGraveyardEntryResponse {
  name: string;
  path: string;
  branch?: string;
  createdAt?: string;
  graveyardedAt?: string;
  agents?: GraveyardEntryResponse[];
  services?: Array<{ id: string; command?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface GraveyardResponse {
  ok: boolean;
  entries: GraveyardEntryResponse[];
  worktrees?: WorktreeGraveyardEntryResponse[];
  [k: string]: unknown;
}

export interface ThreadSummaryResponse {
  thread: { id: string; title?: string; status?: string; kind?: string };
  lastMessage?: { body?: string; createdAt?: string };
  [k: string]: unknown;
}

export interface TaskSummaryResponse {
  id: string;
  description?: string;
  status?: string;
  assignedTo?: string;
  assignedBy?: string;
  assignee?: string;
  tool?: string;
  threadId?: string;
  [k: string]: unknown;
}

export interface TaskListResponse {
  ok: boolean;
  tasks: TaskSummaryResponse[];
  [k: string]: unknown;
}

export interface TaskDetailResponse {
  ok: boolean;
  task: TaskSummaryResponse;
  thread?: ThreadSummaryResponse["thread"];
  messages?: Array<{ id?: string; body?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

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

export async function listWorkflow(
  endpoint: ServiceEndpoint,
  participant = "user",
  opts?: ApiOpts,
): Promise<Array<Record<string, unknown>>> {
  return callProjectJson<Array<Record<string, unknown>>>(
    endpoint,
    "GET",
    `${PROJECT_API_ROUTES.workflow}?participant=${encodeURIComponent(participant)}`,
    opts,
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
// The server builds the reconciled worklist (notifications + threads joined against live agent
// state); clients render and act from it. Mirrors src/coordination-model.ts WorklistItem.

export type CoordinationReachability = "live" | "offline" | "missing" | "none";
export type CoordinationBucket = "awake" | "asleep" | "handled" | "unreachable";
export type CoordinationWorklistType =
  | "msg"
  | "note"
  | "task"
  | "review"
  | "handoff"
  | "conversation";

export interface CoordinationWorklistItem {
  key: string;
  kind: "notification" | "thread";
  sessionId?: string;
  type: CoordinationWorklistType;
  bucket: CoordinationBucket;
  title: string;
  urgency: number;
  reachability: CoordinationReachability;
  actionable: boolean;
  stale: boolean;
  when?: string;
  /** Agent-keyed notification rollup (for notification rows); shape mirrors CoordinationItem. */
  notification?: Record<string, unknown>;
  /** Genuine thread entry (for thread rows); shape mirrors WorkflowEntry. */
  thread?: Record<string, unknown>;
}

export interface CoordinationWorklistResponse {
  ok: boolean;
  worklist: {
    items: CoordinationWorklistItem[];
    needsYou: CoordinationWorklistItem[];
    tail: CoordinationWorklistItem[];
  };
  model: {
    items: Array<Record<string, unknown>>;
    actionable: Array<Record<string, unknown>>;
    unreachable: Array<Record<string, unknown>>;
  };
  threads: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

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

export interface ProjectObservabilityResponse {
  ok: boolean;
  project: {
    summary: {
      agentsRunning: number;
      agentsWaiting: number;
      agentsOffline: number;
      services: number;
      worktrees: number;
      openTasks: number;
      doneTasks: number;
      unreadNotifications: number;
    };
    progress: {
      pending: number;
      assigned: number;
      in_progress: number;
      blocked: number;
      done: number;
      failed: number;
      total: number;
    };
    story: Array<{
      id: string;
      kind: "task" | "review" | "notification";
      title: string;
      meta: string;
      body?: string;
      createdAt: string;
      status?: string;
    }>;
  };
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

export interface ProjectTopologyResponse {
  ok: boolean;
  topology: {
    projectName: string;
    health: "active" | "attention" | "idle" | "offline";
    counts: { worktrees: number; agents: number; services: number };
    worktrees: Array<{
      name: string;
      branch: string;
      path?: string;
      health: "active" | "attention" | "idle" | "offline";
      agents: number;
      services: number;
    }>;
    rows: Array<{
      kind: "worktree" | "agent" | "service";
      depth: number;
      label: string;
      detail?: string;
      health: "active" | "attention" | "idle" | "offline";
      status?: string;
      sessionId?: string;
      serviceId?: string;
      worktreePath?: string;
    }>;
  };
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

export interface LibraryDocument {
  id: string;
  title: string;
  path: string;
  kind: string;
  size: number;
  updatedAt: string;
  content: string;
  truncated?: boolean;
}

export interface LibraryEntry {
  id: string;
  kind: "doc" | "plan";
  title: string;
  path: string;
  updatedAt: string;
  sessionId?: string;
  label?: string;
  preview: string;
}

export interface LibraryResponse {
  ok: boolean;
  documents: LibraryDocument[];
  entries: LibraryEntry[];
}

export async function listProjectLibrary(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<LibraryResponse> {
  return callProjectJson<LibraryResponse>(endpoint, "GET", PROJECT_API_ROUTES.library, opts);
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
