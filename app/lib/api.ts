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
import type { AgentInputPart, ChatMessage, ParsedAgentOutput } from "@/lib/events";

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

// ── Daemon (port 9876) ────────────────────────────────────────────────────

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
  return callJson<DaemonHealth>(`${getDaemonUrl()}/health`, { method: "GET" }, opts);
}

export async function listProjects(opts?: ApiOpts): Promise<DaemonProject[]> {
  const data = await callJson<{ ok: boolean; projects: DaemonProject[] }>(
    `${getDaemonUrl()}/projects`,
    { method: "GET" },
    opts,
  );
  return data.projects;
}

export async function ensureProject(projectRoot: string, opts?: ApiOpts): Promise<unknown> {
  return callJson(
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
  return callJson<ProjectStateResponse>(
    `${getServiceUrl(endpoint)}/state`,
    { method: "GET" },
    opts,
  );
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
  const url = `${getServiceUrl(endpoint)}/agents/history?sessionId=${encodeURIComponent(sessionId)}&lastN=${lastN}`;
  return callJson<AgentHistoryResponse>(url, { method: "GET" }, opts);
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
  const url = `${getServiceUrl(endpoint)}/agents/output?${params.toString()}`;
  return callJson<AgentOutputResponse>(url, { method: "GET" }, opts);
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
  return callJson<AgentInputResult>(
    `${getServiceUrl(endpoint)}/agents/input`,
    { method: "POST", body: JSON.stringify(input) },
    opts,
  );
}

// ── Plans (Task 2 endpoints) ─────────────────────────────────────────────

export interface PlanResponse {
  ok: boolean;
  sessionId: string;
  path: string;
  content: string;
}

export async function getPlan(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<PlanResponse> {
  return callJson<PlanResponse>(
    `${getServiceUrl(endpoint)}/plans/${encodeURIComponent(sessionId)}`,
    { method: "GET" },
    opts,
  );
}

export async function putPlan(
  endpoint: ServiceEndpoint,
  sessionId: string,
  content: string,
  opts?: ApiOpts,
): Promise<{ ok: boolean; sessionId: string; path: string }> {
  return callJson(
    `${getServiceUrl(endpoint)}/plans/${encodeURIComponent(sessionId)}`,
    { method: "PUT", body: JSON.stringify({ content }) },
    opts,
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
  return callJson<AttachmentResponse>(
    `${getServiceUrl(endpoint)}/attachments`,
    { method: "POST", body: JSON.stringify(input) },
    opts,
  );
}

// ── Worktrees, graveyard, threads (list-only for v1) ────────────────────

export async function listWorktrees(endpoint: ServiceEndpoint, opts?: ApiOpts): Promise<unknown> {
  return callJson(`${getServiceUrl(endpoint)}/worktrees`, { method: "GET" }, opts);
}

export async function listGraveyard(endpoint: ServiceEndpoint, opts?: ApiOpts): Promise<unknown> {
  return callJson(`${getServiceUrl(endpoint)}/graveyard`, { method: "GET" }, opts);
}

export async function listThreads(
  endpoint: ServiceEndpoint,
  sessionId?: string,
  opts?: ApiOpts,
): Promise<unknown> {
  const url = sessionId
    ? `${getServiceUrl(endpoint)}/threads?session=${encodeURIComponent(sessionId)}`
    : `${getServiceUrl(endpoint)}/threads`;
  return callJson(url, { method: "GET" }, opts);
}
