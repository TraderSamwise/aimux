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
import type { MachineListFailure } from "@/lib/project-list-status";
import type { RelayMachine, RelayTransport } from "@/lib/relay-transport";
import type { DesktopState } from "@/lib/desktop-state";
import type { ParsedAgentOutput } from "@/lib/events";
import {
  isQueuedLifecycleRoute,
  PROJECT_API_ROUTES,
  QUEUED_LIFECYCLE_MAX_TIMEOUT_MS,
  queuedLifecycleTimeoutMs,
  type GlobalExposeItemsResponse,
  type TeamConfigResponse,
  type ActiveWindowRequest,
  type AgentListResponse,
  type AgentLoopInput,
  type AgentLoopResponse,
  type AgentOverseerInput,
  type AgentPlaneInput,
  type AgentPlaneResponse,
  type AgentOverseerResponse,
  type AgentScribeInput,
  type AgentScribeResponse,
  type AgentWatchInput,
  type AgentWatchResponse,
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
  type LivePaneInterruptResponse,
  type LivePaneOutputInput,
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
  type ReapDeadAgentsInput,
  type ReapDeadAgentsResponse,
  type RenameAgentInput,
  type RenameAgentResponse,
  type RemoveServiceResponse,
  type RemoveWorktreeResponse,
  type ResumeAgentResponse,
  type RestorePreviousAgentsResponse,
  type ResumeServiceResponse,
  type ResurrectAgentResponse,
  type ResurrectWorktreeResponse,
  type HandoffSendInput,
  type SpawnAgentInput,
  type SpawnAgentResponse,
  type StatuslineRefreshInput,
  type StatuslineRefreshResponse,
  type StopAgentResponse,
  type SwitchAgentToolInput,
  type SwitchAgentToolResponse,
  type StopServiceResponse,
  type SwitchableAgentsInput,
  type SwitchableAgentsResponse,
  type SwitchAgentRequest,
  type TaskAssignInput,
  type TaskCancelInput,
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
  type WorkOutlineListResponse,
  type WorkOutlineQuery,
  type WorkOutlineShowResponse,
  type WorkOutlineUpdateInput,
  type WorkOutlineUpdateResponse,
  type WorkflowMutationResponse,
  type WorktreesResponse,
  type WorktreePathInput,
} from "../../src/project-api-contract";
import { CORE_API_ROUTES } from "../../src/core-command-contract";

export type {
  AgentLane,
  AgentRole,
  AgentRoleMutationRefusalReason,
  AgentRoleState,
  AgentSupervisorRole,
  AgentWatchInput,
  AgentWatchRefusalReason,
  AgentWatchResponse,
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
  TaskCancelInput,
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
  // Which machine must answer. Only meaningful over the relay, and only needed
  // once an account has more than one machine connected -- the relay resolves
  // an absent machine when there is exactly one, and refuses to guess when
  // there are several.
  machineId?: string;
}

/// A request the app abandoned, as opposed to one that failed.
///
/// `cancelled` is the app's own doing — a superseded poll, a screen that
/// unmounted, a navigation away — so nothing failed and nobody needs told.
/// It used to be recognised by matching the sentence this file writes, from a
/// module that does not write it, and the two drifted apart: the filter looks
/// for "aborted" while this says "Request was cancelled". So it reached the
/// user as a red banner for something that had already healed.
///
/// A TIMEOUT deliberately has no kind. It is a real failure — the request did
/// not complete — and the same filter guards user-initiated actions, where
/// swallowing it would leave a stop button that spins, stops, and says
/// nothing.
export type ApiFailureKind = "cancelled";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
    public readonly kind?: ApiFailureKind,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_API_TIMEOUT_MS = 10_000;

function apiErrorMessageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  const base = typeof record.error === "string" ? record.error : fallback;
  const withMachines = appendMachineNames(base, record.machines);
  const tmuxQuery = record.tmuxLiveWindowQuery;
  if (!tmuxQuery || typeof tmuxQuery !== "object") return withMachines;
  const tmuxError = (tmuxQuery as Record<string, unknown>).error;
  if (typeof tmuxError !== "string" || !tmuxError.trim()) return withMachines;
  return `${withMachines}: tmux window query failed: ${tmuxError}`;
}

// The relay refuses a request that names no machine when several are connected,
// and the list it sends back is the only part that tells anyone what to do
// about it. Dropping it leaves "name one with machineId" on screen with nothing
// to name.
function appendMachineNames(message: string, machines: unknown): string {
  if (!Array.isArray(machines) || machines.length === 0) return message;
  const names = machines
    .map((machine) =>
      machine && typeof machine === "object"
        ? ((machine as { name?: unknown; id?: unknown }).name ?? (machine as { id?: unknown }).id)
        : undefined,
    )
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return names.length > 0 ? `${message}: ${names.join(", ")}` : message;
}

function apiTimeoutMs(opts?: ApiOpts): number {
  const requested = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  // A non-finite delay does not mean "never": `setTimeout` coerces it and
  // fires at once, so an infinite budget would abort immediately.
  if (!Number.isFinite(requested)) return QUEUED_LIFECYCLE_MAX_TIMEOUT_MS;
  return Math.max(1, requested);
}

function requestSignal(opts?: ApiOpts): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutMs = apiTimeoutMs(opts);
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

/// Abandoning a queued mutation does not undo it. Saying only that the request
/// timed out invites a retry, and spawn is not idempotent -- that is a second
/// agent. Same sentence the dashboard uses (`dashboard_client.rs`).
function timedOutMessage(timeoutMs: string, target: string): string {
  return isQueuedLifecycleRoute(target)
    ? `Request timed out after ${timeoutMs}ms (${target}) — may still be running, check first`
    : `Request timed out after ${timeoutMs}ms (${target})`;
}

function abortedRequest(
  signal: AbortSignal,
  url: string,
): { message: string; kind: ApiFailureKind | undefined } {
  const reason = signal.reason;
  const reasonMessage = reason instanceof Error ? reason.message : String(reason ?? "");
  const timeout = reasonMessage.match(/^request timed out after (\d+)ms$/);
  if (timeout) {
    return { message: timedOutMessage(timeout[1], url), kind: undefined };
  }
  return { message: `Request was cancelled (${url})`, kind: "cancelled" };
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
      const msg = apiErrorMessageFromBody(body, `HTTP ${res.status}`);
      throw new ApiError(res.status, body, `${msg} (${url})`);
    }
    const body = await res.json();
    if (
      body &&
      typeof body === "object" &&
      "ok" in body &&
      (body as { ok?: unknown }).ok === false
    ) {
      const message = apiErrorMessageFromBody(body, "Request failed");
      throw new ApiError(res.status, body, `${message} (${url})`);
    }
    return body as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal.aborted) {
      const aborted = abortedRequest(signal, url);
      throw new ApiError(0, null, aborted.message, aborted.kind);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, null, `Network request failed (${url}): ${reason}`);
  } finally {
    cleanup();
  }
}

async function withRelayRequestTimeout<T>(
  path: string,
  request: Promise<T>,
  opts?: ApiOpts,
): Promise<T> {
  const timeoutMs = apiTimeoutMs(opts);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const rejectTimedOut = () => {
      reject(new ApiError(0, null, timedOutMessage(String(timeoutMs), path)));
    };
    const rejectCancelled = () => {
      reject(new ApiError(0, null, `Request was cancelled (${path})`, "cancelled"));
    };
    timeout = setTimeout(rejectTimedOut, timeoutMs);
    abortListener = rejectCancelled;
    if (opts?.signal?.aborted) rejectCancelled();
    else opts?.signal?.addEventListener("abort", rejectCancelled, { once: true });
  });
  try {
    return await Promise.race([request, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener) opts?.signal?.removeEventListener("abort", abortListener);
  }
}

async function callDaemonViaRelay<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: ApiOpts,
): Promise<T> {
  return (await callDaemonViaRelayNamingAnswerer<T>(method, path, body, opts)).body;
}

// The same call, keeping which machine answered. The relay stamps that from
// the socket's tags, so it is not a thing the daemon claims -- which makes it
// usable by a caller that could not name a machine because the fleet had not
// been announced yet.
async function callDaemonViaRelayNamingAnswerer<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: ApiOpts,
): Promise<{ body: T; machineId?: string }> {
  const relay = _relay;
  if (!relay) throw new ApiError(0, null, "Relay not connected");
  // Three arguments when no machine is named, so a caller that never cared
  // sends exactly the frame it always sent.
  const result = await withRelayRequestTimeout(
    path,
    opts?.machineId
      ? relay.request(method, path, body, opts.machineId)
      : relay.request(method, path, body),
    opts,
  );
  if (result.status >= 400) {
    throw new ApiError(
      result.status,
      result.body,
      apiErrorMessageFromBody(result.body, `HTTP ${result.status}`),
    );
  }
  return {
    body: result.body as T,
    ...(result.machineId ? { machineId: result.machineId } : {}),
  };
}

async function callServiceViaRelay<T>(
  endpoint: ServiceEndpoint,
  method: string,
  path: string,
  opts?: ApiOpts,
  body?: unknown,
): Promise<T> {
  const proxyPath = `/proxy/${endpoint.host}/${endpoint.port}${path}`;
  // An explicit machine wins; otherwise the address says which host it is on.
  return callDaemonViaRelay<T>(method, proxyPath, body, withEndpointMachine(endpoint, opts));
}

export function shouldRouteViaRelay(): boolean {
  return _relay !== null || env.AIMUX_CONNECTION_MODE === "relay";
}

/// Decided here because this is the last place that holds the BARE route: the
/// relay branch rewrites it to `/proxy/<host>/<port><path>`, which no route
/// list would recognise.
function withQueuedLifecycleTimeout(path: string, opts?: ApiOpts): ApiOpts | undefined {
  if (opts?.timeoutMs !== undefined) return opts;
  const timeoutMs = queuedLifecycleTimeoutMs(path);
  if (timeoutMs === null) return opts;
  return { ...opts, timeoutMs };
}

async function callProjectJson<T>(
  endpoint: ServiceEndpoint,
  method: string,
  path: string,
  opts?: ApiOpts,
  body?: unknown,
): Promise<T> {
  const timed = withQueuedLifecycleTimeout(path, opts);
  if (shouldRouteViaRelay()) return callServiceViaRelay<T>(endpoint, method, path, timed, body);
  return callJson<T>(
    `${getServiceUrl(endpoint)}${path}`,
    {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    timed,
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
  // Carried alongside `relayPath` because a project-event subscription is
  // routed by machine exactly like a request is.
  machineId?: string;
}

function projectStreamRoute(
  endpoint: ServiceEndpoint,
  path: string,
  opts?: ApiOpts,
): ProjectStreamRoute {
  const headers: Record<string, string> = {};
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  const machineId = opts?.machineId ?? endpoint.machineId;
  return {
    path,
    directUrl: `${getServiceUrl(endpoint)}${path}`,
    relayPath: projectProxyPath(endpoint, path),
    headers,
    ...(machineId ? { machineId } : {}),
  };
}

function withEndpointMachine(endpoint: ServiceEndpoint, opts?: ApiOpts): ApiOpts | undefined {
  const machineId = opts?.machineId ?? endpoint.machineId;
  if (!machineId) return opts;
  return { ...opts, machineId };
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
  // Which machine this project is on. Absent in local mode and on a relay that
  // reports no machines. `id` and `path` are NOT unique across machines -- the
  // same checkout path exists on two of Sam's Macs -- so anything that keys a
  // project must key on the pair.
  machineId?: string;
  machineName?: string;
  lastSeen?: string;
  dashboardSessionName: string;
  service: unknown | null;
  serviceAlive: boolean;
  // Whether a tmux dashboard is running on this project -- what "online" means.
  // `undefined` is a third answer: the daemon could not ask tmux, or predates the
  // field. Rendering unknown as offline would call a whole fleet dead.
  dashboardAlive?: boolean;
  serviceEndpoint: ServiceEndpoint | null;
  onlineAgentCount?: number;
}

type RawDaemonProject = Partial<
  Omit<
    DaemonProject,
    "onlineAgentCount" | "serviceAlive" | "dashboardAlive" | "machineId" | "machineName"
  >
> & {
  machineId?: unknown;
  machineName?: unknown;
  onlineAgentCount?: unknown;
  serviceAlive?: unknown;
  dashboardAlive?: unknown;
};

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeServiceEndpoint(value: unknown): ServiceEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const endpoint = value as { host?: unknown; port?: unknown };
  if (typeof endpoint.host !== "string" || typeof endpoint.port !== "number") return null;
  return { host: endpoint.host, port: endpoint.port };
}

// Only a real boolean is an answer. A JSON null, or an older daemon that omits
// the field, stays undefined so callers can tell unknown from offline.
function normalizeDashboardAlive(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeOnlineAgentCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeDaemonProject(project: RawDaemonProject): DaemonProject {
  return {
    id: stringField(project.id),
    name: stringField(project.name),
    path: stringField(project.path),
    machineId: optionalStringField(project.machineId),
    machineName: optionalStringField(project.machineName),
    lastSeen: optionalStringField(project.lastSeen),
    dashboardSessionName: stringField(project.dashboardSessionName),
    service: project.service ?? null,
    serviceAlive: project.serviceAlive === true,
    dashboardAlive: normalizeDashboardAlive(project.dashboardAlive),
    serviceEndpoint: normalizeServiceEndpoint(project.serviceEndpoint),
    onlineAgentCount: normalizeOnlineAgentCount(project.onlineAgentCount),
  };
}

function normalizeDaemonProjects(projects: unknown): DaemonProject[] {
  if (!Array.isArray(projects)) return [];
  return projects
    .filter((project): project is RawDaemonProject =>
      Boolean(project && typeof project === "object"),
    )
    .map(normalizeDaemonProject);
}

export async function getDaemonHealth(opts?: ApiOpts): Promise<DaemonHealth> {
  if (shouldRouteViaRelay())
    return callDaemonViaRelay<DaemonHealth>("GET", "/health", undefined, opts);
  return callJson<DaemonHealth>(`${getDaemonUrl()}/health`, { method: "GET" }, opts);
}

export async function listProjects(opts?: ApiOpts): Promise<DaemonProject[]> {
  if (shouldRouteViaRelay()) {
    const data = await callDaemonViaRelay<{ ok: boolean; projects?: unknown }>(
      "GET",
      "/projects",
      undefined,
      opts,
    );
    return normalizeDaemonProjects(data.projects);
  }
  const data = await callJson<{ ok: boolean; projects?: unknown }>(
    `${getDaemonUrl()}/projects`,
    { method: "GET" },
    opts,
  );
  return normalizeDaemonProjects(data.projects);
}

export interface MachineProjectList {
  projects: DaemonProject[];
  failures: MachineListFailure[];
  // The machines this list speaks for. `undefined` means nothing here is
  // scoped by machine -- local mode, or a relay that has not named the fleet --
  // and the list is authoritative for everything, as it always was.
  answeringMachineIds?: string[];
}

// One `/projects` per machine, merged here. The relay stays a router and never
// aggregates, so this is the only place that knows the fleet is plural.
//
// A machine that answers with nothing has no projects; a machine that errors is
// a failure, and the two must not arrive looking alike.
export async function listProjectsAcrossMachines(opts?: ApiOpts): Promise<MachineProjectList> {
  // `namedMachines`, not `machines`: a reconnect clears the live list until
  // the next `daemon_status`, and a machine-less call in that window is
  // refused outright once the account has several.
  const machines = shouldRouteViaRelay() ? (getApiRelay()?.namedMachines ?? []) : [];
  if (machines.length === 0) {
    // Local mode, or a relay that has not told us the fleet yet. One
    // machine-less call is exactly what this did before machines existed --
    // except that the relay now says which machine answered, so this poll's
    // projects are attributed immediately. Without that they arrived bare and
    // the next poll re-keyed every project-scoped atom, remounting the chat
    // view seconds after it opened.
    return listProjectsAttributedToTheAnsweringMachine(opts);
  }
  const results = await Promise.allSettled(
    machines.map(async (machine) =>
      (await listProjects({ ...opts, machineId: machine.id })).map((project) => ({
        ...project,
        machineId: project.machineId ?? machine.id,
        machineName: project.machineName ?? machine.name,
      })),
    ),
  );
  const projects: DaemonProject[] = [];
  const failures: MachineListFailure[] = [];
  const answeringMachineIds: string[] = [];
  results.forEach((result, index) => {
    const machine = machines[index];
    if (result.status === "fulfilled") {
      projects.push(...result.value);
      answeringMachineIds.push(machine.id);
      return;
    }
    failures.push({
      machineId: machine.id,
      machineName: machine.name,
      error: relayFailureMessage(result.reason),
    });
  });
  // Every machine failed: there is no list, only an error. The message is
  // prefixed so a joined set of per-machine messages cannot read as one
  // transient blip and be skipped by the caller.
  if (projects.length === 0 && failures.length === machines.length) {
    throw new ApiError(
      0,
      { failures },
      `No machine answered — ${failures
        .map((failure) => `${failure.machineName}: ${failure.error}`)
        .join("; ")}`,
    );
  }
  return { projects, failures, answeringMachineIds };
}

async function listProjectsAttributedToTheAnsweringMachine(
  opts?: ApiOpts,
): Promise<MachineProjectList> {
  if (!shouldRouteViaRelay()) {
    return { projects: await listProjects(opts), failures: [] };
  }
  const answered = await callDaemonViaRelayNamingAnswerer<{ ok: boolean; projects?: unknown }>(
    "GET",
    "/projects",
    undefined,
    opts,
  );
  const projects = normalizeDaemonProjects(answered.body.projects);
  if (!answered.machineId) return { projects, failures: [] };
  return {
    projects: projects.map((project) => ({
      ...project,
      machineId: project.machineId ?? answered.machineId,
    })),
    failures: [],
    answeringMachineIds: [answered.machineId],
  };
}

function relayFailureMessage(reason: unknown): string {
  if (reason instanceof ApiError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return String(reason ?? "unknown error");
}

export async function listGlobalExposeItems(
  opts?: ApiOpts & {
    includeChatPreview?: boolean;
    clientKind?: "web" | "mobile" | "expose";
    clientId?: string;
  },
): Promise<GlobalExposeItemsResponse> {
  const { includeChatPreview, clientKind, clientId, ...apiOpts } = opts ?? {};
  const params = new URLSearchParams({ includePreview: "1" });
  if (includeChatPreview) params.set("includeChatPreview", "1");
  if (clientKind) params.set("clientKind", clientKind);
  if (clientId) params.set("clientId", clientId);
  const path = `${CORE_API_ROUTES.exposeItems}?${params.toString()}`;
  if (shouldRouteViaRelay()) {
    // "All projects" spans machines, so this spans machines. Named per call,
    // because a request that names none is refused once there are several.
    const machines = getApiRelay()?.namedMachines ?? [];
    if (machines.length === 0) {
      return callDaemonViaRelay<GlobalExposeItemsResponse>("GET", path, undefined, apiOpts);
    }
    const results = await Promise.allSettled(
      machines.map((machine) =>
        callDaemonViaRelay<GlobalExposeItemsResponse>("GET", path, undefined, {
          ...apiOpts,
          machineId: machine.id,
        }),
      ),
    );
    return mergeGlobalExposeItems(machines, results);
  }
  return callJson<GlobalExposeItemsResponse>(
    `${getDaemonUrl()}${path}`,
    { method: "GET" },
    apiOpts,
  );
}

// A machine that errored becomes a project read error, which this response
// already has a place for -- so one host being away shortens the tile list and
// says why, rather than emptying it.
function mergeGlobalExposeItems(
  machines: readonly RelayMachine[],
  results: readonly PromiseSettledResult<GlobalExposeItemsResponse>[],
): GlobalExposeItemsResponse {
  const items: GlobalExposeItemsResponse["items"] = [];
  const projectReadErrors: NonNullable<GlobalExposeItemsResponse["projectReadErrors"]> = [];
  results.forEach((result, index) => {
    const machine = machines[index];
    if (result.status === "fulfilled") {
      items.push(...(result.value.items ?? []).map((item) => ({ ...item, machineId: machine.id })));
      // Stamped with the host, because one checkout failing to read on two
      // machines is otherwise two identical rows with nothing saying which.
      projectReadErrors.push(
        ...(result.value.projectReadErrors ?? []).map((error) =>
          typeof error === "string"
            ? { error, machineName: machine.name || machine.id }
            : { ...error, machineName: machine.name || machine.id },
        ),
      );
      return;
    }
    projectReadErrors.push({
      projectName: machine.name || machine.id,
      error: relayFailureMessage(result.reason),
    });
  });
  const everyMachineFailed = results.every((result) => result.status === "rejected");
  if (items.length === 0 && everyMachineFailed) {
    // No machine answered, so there is no list -- only an error.
    throw new ApiError(
      0,
      { projectReadErrors, failures: projectReadErrors },
      `No machine answered — ${results
        .map((result) => (result.status === "rejected" ? relayFailureMessage(result.reason) : ""))
        .filter(Boolean)
        .join("; ")}`,
    );
  }
  return { ok: true, items, ...(projectReadErrors.length > 0 ? { projectReadErrors } : {}) };
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
    return callDaemonViaRelay<EnsureProjectResponse>(
      "POST",
      "/projects/ensure",
      { projectRoot },
      opts,
    );
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
  return callProjectJson<TeamConfigResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.team.init,
    opts,
    {},
  );
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
  return callProjectJson<TeamConfigResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.team.removeRole,
    opts,
    { role },
  );
}

export async function setDefaultTeamRole(
  endpoint: ServiceEndpoint,
  role: string,
  opts?: ApiOpts,
): Promise<TeamConfigResponse> {
  return callProjectJson<TeamConfigResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.team.defaultRole,
    opts,
    { role },
  );
}

export type AgentOutputResponse = LivePaneOutputResponse & { parsed?: ParsedAgentOutput };

export async function getLivePaneOutput(
  endpoint: ServiceEndpoint,
  sessionId: string,
  startLine?: number,
  opts?: ApiOpts & { mode?: "full" | "chat"; purpose?: LivePaneOutputInput["purpose"] },
): Promise<AgentOutputResponse> {
  const params = new URLSearchParams({ sessionId });
  if (startLine !== undefined) params.set("startLine", String(startLine));
  if (opts?.mode) params.set("mode", opts.mode);
  if (opts?.purpose) params.set("purpose", opts.purpose);
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
      mode: input.mode,
      purpose: input.purpose,
    }),
    opts,
  );
}

export type SendAgentInputResponse = LivePaneInputResponse;

export interface SharedChatActorInput {
  role: "owner" | "guest";
  displayName?: string;
  email?: string;
}

export interface SendAgentInputOptions extends ApiOpts {
  attachmentIds?: string[];
  sharedChatActor?: SharedChatActorInput;
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
      ...(opts?.sharedChatActor ? { sharedChatActor: opts.sharedChatActor } : {}),
    },
  );
}

export const sendAgentInput = sendLivePaneInput;

export async function interruptLivePane(
  endpoint: ServiceEndpoint,
  sessionId: string,
  opts?: ApiOpts,
): Promise<LivePaneInterruptResponse> {
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

export async function switchAgentTool(
  endpoint: ServiceEndpoint,
  input: SwitchAgentToolInput,
  opts?: ApiOpts,
): Promise<SwitchAgentToolResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.switchTool, opts, input);
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

export async function restorePreviousAgents(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<RestorePreviousAgentsResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.restorePrevious, opts, {});
}

export async function dismissRestorePreviousAgents(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts,
): Promise<{ ok: true }> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.agents.dismissRestorePrevious,
    opts,
    {},
  );
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

export async function setAgentPlane(
  endpoint: ServiceEndpoint,
  input: AgentPlaneInput,
  opts?: ApiOpts,
): Promise<AgentPlaneResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.plane, opts, input);
}

export async function setAgentScribe(
  endpoint: ServiceEndpoint,
  input: AgentScribeInput,
  opts?: ApiOpts,
): Promise<AgentScribeResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.scribe, opts, input);
}

export async function setAgentWatch(
  endpoint: ServiceEndpoint,
  input: AgentWatchInput,
  opts?: ApiOpts,
): Promise<AgentWatchResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.agents.watch, opts, input);
}

function workOutlineQueryPath(query?: WorkOutlineQuery & { entryId?: string }): string {
  if (!query) return PROJECT_API_ROUTES.workOutline.list;
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.sessionId) params.set("sessionId", query.sessionId);
  if (query.worktreePath) params.set("worktreePath", query.worktreePath);
  if (query.status) params.set("status", query.status);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.entryId) params.set("entryId", query.entryId);
  const rendered = params.toString();
  return rendered
    ? `${PROJECT_API_ROUTES.workOutline.list}?${rendered}`
    : PROJECT_API_ROUTES.workOutline.list;
}

export async function listWorkOutline(
  endpoint: ServiceEndpoint,
  query?: WorkOutlineQuery,
  opts?: ApiOpts,
): Promise<WorkOutlineListResponse> {
  return callProjectJson(endpoint, "GET", workOutlineQueryPath(query), opts);
}

export async function showWorkOutlineEntry(
  endpoint: ServiceEndpoint,
  entryId: string,
  opts?: ApiOpts,
): Promise<WorkOutlineShowResponse> {
  return callProjectJson(endpoint, "GET", workOutlineQueryPath({ entryId }), opts);
}

export async function updateWorkOutline(
  endpoint: ServiceEndpoint,
  input: WorkOutlineUpdateInput,
  opts?: ApiOpts,
): Promise<WorkOutlineUpdateResponse> {
  return callProjectJson(endpoint, "POST", PROJECT_API_ROUTES.workOutline.update, opts, input);
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

export type UploadAttachmentKind = "image" | "audio" | "video" | "pdf" | "text" | "file";

export interface UploadAttachmentInput {
  kind?: UploadAttachmentKind;
  filename: string;
  mimeType: string;
  dataBase64: string;
  /** The session that will own it; the service refuses an unowned upload. */
  sessionId: string;
}

export interface UploadAttachmentResponse {
  ok: boolean;
  attachment: {
    id: string;
    kind: UploadAttachmentKind;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
    source: "path" | "upload";
    contentUrl: string;
    hostedContentUrl?: string;
    hostedExpiresAt?: string;
  };
}

export async function uploadAttachment(
  endpoint: ServiceEndpoint,
  input: UploadAttachmentInput,
  opts?: ApiOpts,
): Promise<UploadAttachmentResponse> {
  return callProjectJson<UploadAttachmentResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.attachments,
    opts,
    {
      kind: input.kind ?? "file",
      filename: input.filename,
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
      sessionId: input.sessionId,
    },
  );
}

export type UploadImageAttachmentInput = UploadAttachmentInput;
export type UploadImageAttachmentResponse = UploadAttachmentResponse;

export async function uploadImageAttachment(
  endpoint: ServiceEndpoint,
  input: UploadImageAttachmentInput,
  opts?: ApiOpts,
): Promise<UploadImageAttachmentResponse> {
  return uploadAttachment(endpoint, { ...input, kind: "image" }, opts);
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
  // The machine travels as its own field, so the share is bound to the host
  // that is sharing it. It is kept out of `serviceEndpoint` because that goes
  // on to the guest, and a guest is told nothing about the fleet.
  return callJson<ShareInviteResponse>(
    `${relayHttpUrl()}/shares/invite`,
    {
      method: "POST",
      body: JSON.stringify({
        projectRoot,
        sessionId,
        email,
        ...(serviceEndpoint?.machineId ? { machineId: serviceEndpoint.machineId } : {}),
        serviceEndpoint: serviceEndpoint
          ? { host: serviceEndpoint.host, port: serviceEndpoint.port }
          : serviceEndpoint,
      }),
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

export async function revokeShareInvite(
  ownerUserId: string,
  shareId: string,
  inviteId: string,
  opts?: ApiOpts,
): Promise<ShareResponse> {
  return callJson<ShareResponse>(
    `${relayHttpUrl()}/shares/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(shareId)}/invites/${encodeURIComponent(
      inviteId,
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
  opts?: ApiOpts & { includePreview?: boolean; includeChatPreview?: boolean },
): Promise<DesktopState> {
  const { includePreview, includeChatPreview, ...apiOpts } = opts ?? {};
  const params = new URLSearchParams();
  if (includePreview) params.set("includePreview", "1");
  if (includeChatPreview) params.set("includeChatPreview", "1");
  const query = params.toString();
  const path = query
    ? `${PROJECT_API_ROUTES.desktopState}?${query}`
    : PROJECT_API_ROUTES.desktopState;
  return callProjectJson<DesktopState>(endpoint, "GET", path, apiOpts);
}

// ── Notifications ────────────────────────────────────────────────────────

export async function listNotifications(
  endpoint: ServiceEndpoint,
  opts?: ApiOpts & { unreadOnly?: boolean; sessionId?: string; limit?: number },
): Promise<NotificationsResponse> {
  const params = new URLSearchParams();
  if (opts?.unreadOnly) params.set("unread", "1");
  if (opts?.sessionId) params.set("sessionId", opts.sessionId);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
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

export async function reapDeadGraveyardAgents(
  endpoint: ServiceEndpoint,
  input: ReapDeadAgentsInput = {},
  opts?: ApiOpts,
): Promise<ReapDeadAgentsResponse> {
  return callProjectJson(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.graveyardActions.reapDeadAgents,
    opts,
    input,
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
  opts?: ApiOpts & { limit?: number },
): Promise<ThreadSummaryResponse[]> {
  const params = new URLSearchParams();
  if (sessionId) params.set("session", sessionId);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const query = params.toString();
  const path = `${PROJECT_API_ROUTES.threads.list}${query ? `?${query}` : ""}`;
  return callProjectJson<ThreadSummaryResponse[]>(endpoint, "GET", path, opts);
}

export interface SessionMarkSeenInput {
  session: string;
}

export interface SessionMarkSeenResponse {
  ok: boolean;
  notificationsRead?: number;
  notificationThreadsRead?: number;
  attentionCleared?: boolean;
}

// The same route the tmux window-change hook calls, so entering an agent
// clears the count identically from the app and from the terminal.
export async function markSessionSeen(
  endpoint: ServiceEndpoint,
  input: SessionMarkSeenInput,
  opts?: ApiOpts,
): Promise<SessionMarkSeenResponse> {
  return callProjectJson<SessionMarkSeenResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.runtime.markSeen,
    opts,
    input,
  );
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

export async function cancelTask(
  endpoint: ServiceEndpoint,
  input: TaskCancelInput,
  opts?: ApiOpts,
): Promise<WorkflowMutationResponse> {
  return callProjectJson<WorkflowMutationResponse>(
    endpoint,
    "POST",
    PROJECT_API_ROUTES.tasks.cancel,
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
  filters?: { sessionId?: string; status?: string; limit?: number },
  opts?: ApiOpts,
): Promise<TaskListResponse> {
  const params = new URLSearchParams();
  if (filters?.sessionId) params.set("session", filters.sessionId);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
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
