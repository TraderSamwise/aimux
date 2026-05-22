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
import type { RelayTransport } from "@/lib/relay-transport";
import type { DesktopState } from "@/lib/desktop-state";
import type { AgentInputPart, ChatMessage, ParsedAgentOutput } from "@/lib/events";

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

async function callProjectJson<T>(
  endpoint: ServiceEndpoint,
  method: string,
  path: string,
  opts?: ApiOpts,
  body?: unknown,
): Promise<T> {
  if (_relay?.wsConnected) return callServiceViaRelay<T>(endpoint, method, path, body);
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

export interface ProjectSession {
  id: string;
  tool: string;
  status: "running" | "idle" | "waiting" | "offline";
  label?: string;
  headline?: string;
  role?: string;
  worktreePath?: string;
  ownerPid?: number;
}

export interface DaemonProject {
  id: string;
  name: string;
  path: string;
  lastSeen?: string;
  dashboardSessionName: string;
  sessions: ProjectSession[];
  service: unknown | null;
  serviceAlive: boolean;
  serviceEndpoint: ServiceEndpoint | null;
}

export async function getDaemonHealth(opts?: ApiOpts): Promise<DaemonHealth> {
  if (_relay?.wsConnected) return callDaemonViaRelay<DaemonHealth>("GET", "/health");
  return callJson<DaemonHealth>(`${getDaemonUrl()}/health`, { method: "GET" }, opts);
}

export async function listProjects(opts?: ApiOpts): Promise<DaemonProject[]> {
  if (_relay?.wsConnected) {
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
  if (_relay?.wsConnected)
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

export interface AgentHistoryResponse {
  sessionId: string;
  messages: ChatMessage[];
  lastN?: number;
}

export async function getAgentHistory(
  endpoint: ServiceEndpoint,
  sessionId: string,
  lastN: number = 50,
  opts?: ApiOpts,
): Promise<AgentHistoryResponse> {
  const path = `/agents/history?sessionId=${encodeURIComponent(sessionId)}&lastN=${lastN}`;
  return callProjectJson<AgentHistoryResponse>(endpoint, "GET", path, opts);
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

export interface AgentInputRequest {
  sessionId: string;
  data?: string;
  parts?: AgentInputPart[];
  clientMessageId?: string;
  submit?: boolean;
}

export interface AgentInputResult {
  ok: boolean;
  accepted: boolean;
  messageId?: string;
  operation?: { id?: string; state?: string };
  error?: string;
  [k: string]: unknown;
}

export async function sendAgentInput(
  endpoint: ServiceEndpoint,
  input: AgentInputRequest,
  opts?: ApiOpts,
): Promise<AgentInputResult> {
  return callProjectJson<AgentInputResult>(endpoint, "POST", "/agents/input", opts, input);
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

// ── Attachments ──────────────────────────────────────────────────────────

export interface AttachmentResponse {
  ok: boolean;
  attachment: {
    id: string;
    contentUrl: string;
    filename?: string;
    mimeType?: string;
  };
}

export async function uploadAttachmentBase64(
  endpoint: ServiceEndpoint,
  input: { filename: string; mimeType: string; contentBase64: string },
  opts?: ApiOpts,
): Promise<AttachmentResponse> {
  return callProjectJson<AttachmentResponse>(endpoint, "POST", "/attachments", opts, input);
}

// ── Desktop state (project → worktree → agents | services hierarchy) ────

export async function getDesktopState(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<DesktopState> {
  return callProjectJson<DesktopState>(endpoint, "GET", "/desktop-state", opts);
}

// ── Agent actions ────────────────────────────────────────────────────────

export interface AgentSpawnInput {
  tool: string;
  worktreePath?: string;
  label?: string;
  role?: string;
}

export async function spawnAgent(
  endpoint: ServiceEndpoint,
  input: AgentSpawnInput,
  opts?: ApiOpts,
): Promise<{ ok: boolean; sessionId: string }> {
  return callProjectJson(endpoint, "POST", "/agents/spawn", opts, input);
}

export async function forkAgent(
  endpoint: ServiceEndpoint,
  input: { sessionId: string; tool?: string; worktreePath?: string },
  opts?: ApiOpts,
): Promise<{ ok: boolean; sessionId: string }> {
  return callProjectJson(endpoint, "POST", "/agents/fork", opts, input);
}

export async function stopAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean }> {
  return callProjectJson(endpoint, "POST", "/agents/stop", opts, { sessionId });
}

export async function resumeAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean }> {
  return callProjectJson(endpoint, "POST", "/agents/resume", opts, { sessionId });
}

export async function interruptAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean }> {
  return callProjectJson(endpoint, "POST", "/agents/interrupt", opts, { sessionId });
}

export async function renameAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  label: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean }> {
  return callProjectJson(endpoint, "POST", "/agents/rename", opts, { sessionId, label });
}

export async function migrateAgent(
  endpoint: ServiceEndpoint,
  input: { sessionId: string; worktreePath?: string },
  opts?: ApiOpts,
): Promise<{ ok: boolean }> {
  return callProjectJson(endpoint, "POST", "/agents/migrate", opts, input);
}

export async function killAgent(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean }> {
  return callProjectJson(endpoint, "POST", "/agents/kill", opts, { sessionId });
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
