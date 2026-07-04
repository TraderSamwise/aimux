import type { CoreProjectServiceState, CoreRelaySnapshot, CoreStatusProject } from "./core-command-contract.js";

export interface CoreDaemonStatusTextPayload {
  daemon: { pid?: number; port?: number; serviceInfo?: unknown } | null;
  projects: Array<{ serviceAlive?: boolean }>;
  relay: CoreRelaySnapshot;
}

export interface CoreHostStatusTextPayload {
  projectRoot: string;
  sessionName: string | null;
  daemon: { serviceInfo?: unknown };
  projectService: unknown | null;
  serviceAlive: boolean;
  metadataEndpoint: unknown;
  expectedServiceManifest: unknown;
}

export interface CoreProjectEnsureTextPayload {
  project: CoreProjectServiceState;
}

export interface CoreRemoteStatusTextPayload {
  credentials: { relayUrl: string; remoteEnabled: boolean } | null;
  relay: CoreRelaySnapshot;
}

export interface CoreWhoamiTextPayload {
  credentials: { userId: string; relayUrl: string; remoteEnabled: boolean } | null;
}

export type CoreLogoutTextResult = "cleared" | "none" | "failed";

export interface CoreLoginTextPayload {
  userId: string;
  relay: CoreRelaySnapshot;
}

export interface CoreLifecycleSpawnTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: unknown;
  tool: string;
  worktreePath: string;
  opened: boolean;
}

export interface CoreLifecycleStopTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: unknown;
  status: unknown;
}

export interface CoreLifecycleKillTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: unknown;
  status: unknown;
  previousStatus: unknown;
}

export interface CoreLifecycleForkTextPayload extends CoreLifecycleSpawnTextPayload {
  sourceSessionId: string;
  threadId: unknown;
}

export interface CoreWorktreeSummaryTextPayload {
  worktrees: unknown[];
}

export interface CoreWorktreeCreateTextPayload {
  ok: true;
  name: string;
  path: string;
  status: "creating" | "created";
  projectRoot: string;
}

export interface CoreWorktreePathTextPayload {
  ok: true;
  projectRoot: string;
  path: string;
  status: string;
}

export interface CoreGraveyardTextPayload {
  entries: unknown[];
  worktrees: unknown[];
}

export interface CoreGraveyardAgentTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: string;
  status: string;
  previousStatus?: string;
}

export interface CoreGraveyardCleanupTextPayload {
  ok: true;
  projectRoot: string;
  result: unknown;
}

export interface CoreThreadListTextPayload {
  summaries: unknown[];
}

export interface CoreThreadShowTextPayload {
  thread: unknown;
  messages: unknown[];
}

export interface CoreThreadOpenTextPayload {
  thread: unknown;
}

export interface CoreThreadSendTextPayload {
  message: unknown;
}

export interface CoreThreadStatusTextPayload {
  thread: unknown;
}

export interface CoreMessageSendTextPayload {
  thread: unknown;
  message: unknown;
  deliveredTo?: unknown;
}

function coreProjectServicePid(projectService: unknown): number | null {
  return projectService &&
    typeof projectService === "object" &&
    typeof (projectService as { pid?: unknown }).pid === "number"
    ? (projectService as { pid: number }).pid
    : null;
}

export function renderCoreDaemonStatusLines(payload: CoreDaemonStatusTextPayload): string[] {
  const daemon = payload.daemon;
  if (!daemon) return ["aimux daemon is not running."];
  const lines = [`Daemon pid=${daemon.pid} port=${daemon.port}`];
  lines.push(`Known projects: ${payload.projects.length}`);
  lines.push(`Live project services: ${payload.projects.filter((project) => project.serviceAlive).length}`);
  const relay = payload.relay;
  if (relay.status && relay.status !== "off") {
    lines.push(`Relay: ${relay.status}${relay.relayUrl ? ` (${relay.relayUrl})` : ""}`);
  } else {
    lines.push("Relay: off");
  }
  return lines;
}

export function renderCoreHostStatusLines(payload: CoreHostStatusTextPayload, knownProject: boolean): string[] {
  if (!knownProject) return [`No known control service for ${payload.projectRoot}`];
  const lines = [`Service: ${payload.serviceAlive ? "live" : "idle"}`];
  const pid = coreProjectServicePid(payload.projectService);
  if (pid !== null) lines.push(`Service pid=${pid}`);
  lines.push(`Metadata: ${payload.metadataEndpoint ? JSON.stringify(payload.metadataEndpoint) : "not running"}`);
  lines.push(`Expected manifest: ${JSON.stringify(payload.expectedServiceManifest)}`);
  lines.push(`Tmux session: ${payload.sessionName}`);
  return lines;
}

export function renderCoreProjectEnsureLines(payload: CoreProjectEnsureTextPayload): string[] {
  return [`Ensured project service for ${payload.project.projectRoot} (pid ${payload.project.pid})`];
}

export function renderCoreDaemonProjectsLines(projects: CoreStatusProject[]): string[] {
  return projects.map((project) => {
    const badge = project.serviceAlive ? "service" : "idle";
    return `${project.name}  ${badge}  ${project.path}`;
  });
}

export function renderCoreProjectsListLines(projects: CoreStatusProject[]): string[] {
  if (projects.length === 0) return ["No aimux projects found."];
  return projects.map((project) => {
    const liveBadge = project.serviceAlive ? "live" : "idle";
    return `${project.name}  ${liveBadge}  ${project.path}`;
  });
}

function relayLastError(relay: CoreRelaySnapshot): string | null {
  return "lastError" in relay ? relay.lastError : null;
}

export function renderCoreRemoteStatusLines(payload: CoreRemoteStatusTextPayload): string[] {
  const { credentials, relay } = payload;
  if (!credentials) return ["Not logged in. Run `aimux login` to enable remote access."];
  const lines = [
    `Remote access: ${credentials.remoteEnabled ? "enabled" : "disabled"}`,
    `Relay: ${credentials.relayUrl}`,
    `Connection: ${relay.status ?? "unknown"}`,
  ];
  const lastError = relayLastError(relay);
  if (lastError) lines.push(`Last error: ${lastError}`);
  return lines;
}

export function renderCoreRemoteEnableLines(relay: CoreRelaySnapshot): string[] {
  return [`✓ Remote access enabled (connection: ${relay.status ?? "unknown"})`];
}

export function renderCoreRemoteDisableLines(daemonDisconnected: boolean): string[] {
  return [
    daemonDisconnected ? "✓ Remote access disabled. Daemon disconnected from relay." : "✓ Remote access disabled.",
  ];
}

export function renderCoreWhoamiLines(payload: CoreWhoamiTextPayload): string[] {
  const credentials = payload.credentials;
  if (!credentials) return ["Not logged in. Run `aimux login` to enable remote access."];
  return [
    `Logged in as ${credentials.userId}`,
    `Relay: ${credentials.relayUrl}`,
    `Remote access: ${credentials.remoteEnabled ? "enabled" : "disabled"}`,
  ];
}

export function coreWhoamiJson(
  payload: CoreWhoamiTextPayload,
): { loggedIn: true; userId: string; relayUrl: string; remoteEnabled: boolean } | { loggedIn: false } {
  const credentials = payload.credentials;
  return credentials
    ? {
        loggedIn: true,
        userId: credentials.userId,
        relayUrl: credentials.relayUrl,
        remoteEnabled: credentials.remoteEnabled,
      }
    : { loggedIn: false };
}

export function renderCoreLogoutLines(result: CoreLogoutTextResult): string[] {
  if (result === "cleared") return ["✓ Logged out. Remote access disabled."];
  if (result === "none") return ["Not logged in."];
  return ["Failed to remove credentials file — check permissions."];
}

export function renderCoreLoginLines(payload: CoreLoginTextPayload): string[] {
  return ["", `✓ Logged in as ${payload.userId}`, ...renderRelayAuthLines(payload.relay)];
}

export function renderCoreSecurityUnlockLines(payload: CoreLoginTextPayload): string[] {
  return ["", `✓ Security unlocked for ${payload.userId}`, ...renderRelayAuthLines(payload.relay)];
}

export function renderCoreLifecycleSpawnLines(payload: CoreLifecycleSpawnTextPayload): string[] {
  return [`spawned ${String(payload.sessionId)}`];
}

export function renderCoreLifecycleStopLines(payload: CoreLifecycleStopTextPayload): string[] {
  return [`stopped ${String(payload.sessionId)}`];
}

export function renderCoreLifecycleKillLines(payload: CoreLifecycleKillTextPayload): string[] {
  return [`graveyarded ${String(payload.sessionId)}`];
}

export function renderCoreLifecycleForkLines(payload: CoreLifecycleForkTextPayload): string[] {
  return [`forked ${String(payload.sessionId)}`, `thread ${String(payload.threadId)}`];
}

export function renderCoreWorktreeListLines(payload: CoreWorktreeSummaryTextPayload): string[] {
  const worktrees = payload.worktrees.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  if (worktrees.length === 0) return ["No worktrees found."];
  return renderWorktreeTableLines(worktrees, "");
}

export function renderCoreWorktreeCreateLines(payload: CoreWorktreeCreateTextPayload): string[] {
  if (payload.status === "creating") {
    return [`Creating worktree "${payload.name}"${payload.path ? ` (${payload.path})` : ""}.`];
  }
  return [`Created worktree "${payload.name}" at ${payload.path}`];
}

export function renderCoreWorktreeRemoveLines(payload: CoreWorktreePathTextPayload): string[] {
  return [`${payload.status === "removing" ? "removing" : "removed"} ${payload.path}`];
}

export function renderCoreWorktreeGraveyardLines(payload: CoreWorktreePathTextPayload): string[] {
  return [`graveyarded ${payload.path}`];
}

export function renderCoreWorktreeResurrectLines(payload: CoreWorktreePathTextPayload): string[] {
  return [`resurrected ${payload.path}`];
}

export function renderCoreWorktreeDeleteGraveyardLines(payload: CoreWorktreePathTextPayload): string[] {
  return [`deleted ${payload.path}`];
}

export function renderCoreGraveyardLines(payload: CoreGraveyardTextPayload): string[] {
  const entries = payload.entries.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  const worktrees = payload.worktrees.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  if (entries.length === 0 && worktrees.length === 0) return ["Graveyard is empty."];
  const lines: string[] = [];
  if (worktrees.length > 0) {
    lines.push("Worktrees", ...renderWorktreeTableLines(worktrees, "?"));
  }
  if (entries.length > 0) {
    if (worktrees.length > 0) lines.push("");
    lines.push("Agents", "ID".padEnd(25) + "Tool".padEnd(15) + "Backend Session ID", "-".repeat(70));
    for (const session of entries) {
      lines.push(
        String(session.id ?? "?").padEnd(25) +
          String(session.command ?? session.tool ?? "?").padEnd(15) +
          String(session.backendSessionId ?? "(none)"),
      );
    }
  }
  return lines;
}

export function renderCoreGraveyardAgentLines(payload: CoreGraveyardAgentTextPayload): string[] {
  const action = payload.status === "graveyard" || payload.status === "graveyarded" ? "graveyarded" : "resurrected";
  return [`${action} ${payload.sessionId}`];
}

function renderWorktreeTableLines(worktrees: Array<Record<string, unknown>>, fallback: string): string[] {
  const lines = ["Name".padEnd(30) + "Branch".padEnd(35) + "Path", "-".repeat(95)];
  for (const worktree of worktrees) {
    lines.push(
      String(worktree.name ?? fallback).padEnd(30) +
        String(worktree.branch ?? "").padEnd(35) +
        String(worktree.path ?? fallback),
    );
  }
  return lines;
}

export function renderCoreGraveyardCleanupLines(payload: CoreGraveyardCleanupTextPayload): string[] {
  const result =
    payload.result && typeof payload.result === "object" ? (payload.result as Record<string, unknown>) : {};
  const plan = result.plan && typeof result.plan === "object" ? (result.plan as Record<string, unknown>) : {};
  if (plan.enabled === false) return ["Graveyard cleanup is disabled."];
  const items = Array.isArray(result.results) ? result.results.filter((item) => item && typeof item === "object") : [];
  const records = items as Array<Record<string, unknown>>;
  const removed = records.filter((item) => item.status === "removed").length;
  const dryRun = records.filter((item) => item.status === "dry-run").length;
  const failed = records.filter((item) => item.status === "failed").length;
  const action = result.dryRun ? "would remove" : "removed";
  const retentionDays = plan.retentionDays ?? "?";
  const lines = [
    `Graveyard cleanup ${action} ${result.dryRun ? dryRun : removed} item(s); ${failed} failed. Retention: ${retentionDays} day(s).`,
  ];
  for (const item of records) {
    const status = item.status === "failed" ? `failed: ${String(item.error ?? "")}` : String(item.status ?? "?");
    lines.push(`${String(item.kind ?? "?")} ${String(item.id ?? "?")}: ${status}`);
  }
  return lines;
}

export function renderCoreThreadListLines(payload: CoreThreadListTextPayload): string[] {
  const summaries = payload.summaries.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  if (summaries.length === 0) return ["No threads found."];
  const lines: string[] = [];
  for (const summary of summaries) {
    const thread =
      summary.thread && typeof summary.thread === "object" ? (summary.thread as Record<string, unknown>) : {};
    const latestMessage =
      summary.latestMessage && typeof summary.latestMessage === "object"
        ? (summary.latestMessage as Record<string, unknown>)
        : null;
    const unreadBy = Array.isArray(thread.unreadBy) ? thread.unreadBy : [];
    const waitingOn = Array.isArray(thread.waitingOn) ? thread.waitingOn : [];
    const unread = unreadBy.length ? ` unread=${unreadBy.length}` : "";
    const waiting = waitingOn.length ? ` waiting=${waitingOn.join(",")}` : "";
    lines.push(
      `${String(thread.id ?? "?")}  ${String(thread.kind ?? "?")}  ${String(thread.status ?? "?")}${unread}${waiting}`,
    );
    lines.push(`  ${String(thread.title ?? "")}`);
    if (latestMessage) {
      lines.push(
        `  latest: ${String(latestMessage.from ?? "?")} [${String(latestMessage.kind ?? "?")}] ${String(
          latestMessage.body ?? "",
        )}`,
      );
    }
  }
  return lines;
}

export function renderCoreThreadShowLines(payload: CoreThreadShowTextPayload): string[] {
  const thread =
    payload.thread && typeof payload.thread === "object" ? (payload.thread as Record<string, unknown>) : {};
  const messages = payload.messages.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  const participants = Array.isArray(thread.participants) ? thread.participants : [];
  const waitingOn = Array.isArray(thread.waitingOn) ? thread.waitingOn : [];
  const lines = [
    `${String(thread.title ?? "")} (${String(thread.kind ?? "?")})`,
    `id: ${String(thread.id ?? "?")}`,
    `status: ${String(thread.status ?? "?")}`,
    `participants: ${participants.join(", ")}`,
  ];
  if (thread.owner) lines.push(`owner: ${String(thread.owner)}`);
  if (waitingOn.length) lines.push(`waitingOn: ${waitingOn.join(", ")}`);
  lines.push("");
  for (const message of messages) {
    lines.push(`${String(message.ts ?? "?")}  ${String(message.from ?? "?")} [${String(message.kind ?? "?")}]`);
    lines.push(`  ${String(message.body ?? "")}`);
  }
  return lines;
}

export function renderCoreThreadOpenLines(payload: CoreThreadOpenTextPayload): string[] {
  return [String((payload.thread as Record<string, unknown>).id)];
}

export function renderCoreThreadSendLines(payload: CoreThreadSendTextPayload): string[] {
  return [String((payload.message as Record<string, unknown>).id)];
}

export function renderCoreThreadMarkSeenLines(): string[] {
  return ["ok"];
}

export function renderCoreThreadStatusLines(payload: CoreThreadStatusTextPayload): string[] {
  const thread = payload.thread as Record<string, unknown>;
  return [`thread ${String(thread.id)}`, `status ${String(thread.status)}`];
}

export function renderCoreMessageSendLines(payload: CoreMessageSendTextPayload): string[] {
  const thread = payload.thread as Record<string, unknown>;
  const message = payload.message as Record<string, unknown>;
  const lines = [`thread ${String(thread.id)}`, `message ${String(message.id)}`];
  if (Array.isArray(payload.deliveredTo) && payload.deliveredTo.length > 0) {
    lines.push(`delivered ${payload.deliveredTo.join(",")}`);
  }
  return lines;
}

function renderRelayAuthLines(relay: CoreRelaySnapshot): string[] {
  const status = relay.status ?? "unknown";
  const lines =
    status === "off"
      ? ["Remote access is enabled. The daemon will connect on next start."]
      : status === "connected" || status === "connecting" || status === "reconnecting"
        ? [`Remote access is enabled (connection: ${status}).`]
        : [`Remote access credentials were saved, but relay is ${status}.`];
  const lastError = relayLastError(relay);
  if (lastError) lines.push(`Last error: ${lastError}`);
  return lines;
}
