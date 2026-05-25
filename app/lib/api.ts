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
  return callProjectJson<ProjectStateResponse>(endpoint, "GET", "/state", opts);
}

export interface AgentOutputResponse {
  sessionId: string;
  output: string;
  startLine?: number;
  parsed?: ParsedAgentOutput;
}

export async function getAgentOutput(
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
    `/agents/output?${params.toString()}`,
    opts,
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
    `/plans/${encodeURIComponent(sessionId)}`,
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
    `/plans/${encodeURIComponent(sessionId)}`,
    opts,
    { content },
  );
}

// ── Desktop state (project → worktree → agents | services hierarchy) ────

export async function getDesktopState(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<DesktopState> {
  return callProjectJson<DesktopState>(endpoint, "GET", "/desktop-state", opts);
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
  unread: boolean;
  cleared: boolean;
  createdAt: string;
  updatedAt: string;
  dedupeKey?: string;
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
    `/notifications${query ? `?${query}` : ""}`,
    opts,
  );
}

export async function markNotificationsRead(
  endpoint: ServiceEndpoint,
  input: { id?: string; sessionId?: string } = {},
  opts?: ApiOpts,
): Promise<{ ok: boolean; updated: number }> {
  return callProjectJson(endpoint, "POST", "/notifications/read", opts, input);
}

export async function clearNotifications(
  endpoint: ServiceEndpoint,
  input: { id?: string; sessionId?: string } = {},
  opts?: ApiOpts,
): Promise<{ ok: boolean; cleared: number }> {
  return callProjectJson(endpoint, "POST", "/notifications/clear", opts, input);
}

// ── Service actions ──────────────────────────────────────────────────────

export async function createService(
  endpoint: ServiceEndpoint,
  input: { command?: string; worktreePath?: string; serviceId?: string },
  opts?: ApiOpts,
): Promise<{ ok: boolean; serviceId: string }> {
  return callProjectJson(endpoint, "POST", "/services/create", opts, input);
}

export async function stopService(
  endpoint: ServiceEndpoint,
  serviceId: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean; serviceId: string; status: "stopped" }> {
  return callProjectJson(endpoint, "POST", "/services/stop", opts, { serviceId });
}

export async function resumeService(
  endpoint: ServiceEndpoint,
  serviceId: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean; serviceId: string; status: "running" }> {
  return callProjectJson(endpoint, "POST", "/services/resume", opts, { serviceId });
}

export async function removeService(
  endpoint: ServiceEndpoint,
  serviceId: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean; serviceId: string; status: "removed" }> {
  return callProjectJson(endpoint, "POST", "/services/remove", opts, { serviceId });
}

// ── Worktree actions ─────────────────────────────────────────────────────

export async function createWorktree(
  endpoint: ServiceEndpoint,
  name: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean; path: string }> {
  return callProjectJson(endpoint, "POST", "/worktrees/create", opts, { name });
}

export async function removeWorktree(
  endpoint: ServiceEndpoint,
  path: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean; path: string }> {
  return callProjectJson(endpoint, "POST", "/worktrees/remove", opts, { path });
}

// ── Worktrees, graveyard, threads (list-only for v1) ────────────────────

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

export interface GraveyardResponse {
  ok: boolean;
  entries: GraveyardEntryResponse[];
  worktrees?: unknown[];
  [k: string]: unknown;
}

export interface ThreadSummaryResponse {
  thread: { id: string; title?: string; status?: string; kind?: string };
  lastMessage?: { body?: string; createdAt?: string };
  [k: string]: unknown;
}

export async function listWorktrees(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<WorktreesResponse> {
  return callProjectJson<WorktreesResponse>(endpoint, "GET", "/worktrees", opts);
}

export async function listGraveyard(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<GraveyardResponse> {
  return callProjectJson<GraveyardResponse>(endpoint, "GET", "/graveyard", opts);
}

export async function listThreads(
  endpoint: ServiceEndpoint,
  sessionId?: string,
  opts?: ApiOpts,
): Promise<ThreadSummaryResponse[]> {
  const path = sessionId ? `/threads?session=${encodeURIComponent(sessionId)}` : "/threads";
  return callProjectJson<ThreadSummaryResponse[]>(endpoint, "GET", path, opts);
}
