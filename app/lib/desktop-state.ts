// Client-side types for the per-project metadata server's GET /desktop-state response,
// plus a lean group-by-worktree helper that mirrors the TUI's dashboard hierarchy.
// Canonical server-side shapes live in src/dashboard/index.ts and src/multiplexer/dashboard-model.ts.

import type { AgentTranscriptMessage } from "@/lib/events";

export type DesktopSessionStatus = "running" | "idle" | "waiting" | "exited" | "offline";
export type DesktopServiceStatus = "running" | "exited" | "offline";
export type ExposePreviewSnapshotSource = "capture" | "tap";
export type ExposeChatPreviewSource = "readAgentOutput";

export interface ExposePreviewSnapshot {
  output: string;
  capturedAt: string;
  source: ExposePreviewSnapshotSource;
}

export interface ExposeChatPreview {
  messages: AgentTranscriptMessage[];
  capturedAt: string;
  source: ExposeChatPreviewSource;
}

export interface DesktopSession {
  id: string;
  command?: string;
  toolConfigKey?: string;
  tmuxWindowId?: string;
  tmuxWindowIndex?: number;
  status: DesktopSessionStatus;
  active?: boolean;
  worktreePath?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  label?: string;
  headline?: string;
  restoreState?: "ready" | "blocked";
  restoreBlockedReason?: string;
  role?: string;
  activity?: string;
  attention?: string;
  unseenCount?: number;
  previewLine?: string;
  pendingAction?: string;
  loop?: { active?: boolean; goal?: string; since?: string } | null;
  overseer?: boolean;
  team?: { role?: string };
  previewSnapshot?: ExposePreviewSnapshot;
  chatPreview?: ExposeChatPreview;
  optimistic?: boolean;
}

export interface DesktopService {
  id: string;
  command?: string;
  args?: string[];
  tmuxWindowId?: string;
  tmuxWindowIndex?: number;
  worktreePath?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  status: DesktopServiceStatus;
  active?: boolean;
  label?: string;
  shellCommand?: string;
  shellCommandState?: "running" | "prompt";
  previewLine?: string;
  pendingAction?: string;
  optimistic?: boolean;
}

export interface DesktopWorktree {
  name: string;
  path: string;
  branch: string;
  isBare?: boolean;
  pending?: boolean;
  removing?: boolean;
}

export interface DesktopWorktreeGroup {
  name: string;
  branch: string;
  path?: string;
  status: "active" | "offline";
  pending?: boolean;
  removing?: boolean;
  sessions: DesktopSession[];
  services: DesktopService[];
}

export interface DesktopState {
  ok: boolean;
  sessions: DesktopSession[];
  teammates?: DesktopSession[];
  services: DesktopService[];
  worktrees: DesktopWorktree[];
  worktreeGroups?: DesktopWorktreeGroup[];
  mainCheckoutInfo?: { name: string; branch: string };
  mainCheckoutPath?: string;
}

export interface WorktreeBucket {
  key: string;
  name: string;
  branch: string;
  path: string | null;
  isMainCheckout: boolean;
  pending?: boolean;
  removing?: boolean;
  sessions: DesktopSession[];
  services: DesktopService[];
}

const MAIN_CHECKOUT_KEY = "__main_checkout__";

export function isDesktopSessionOffline(
  session: Pick<DesktopSession, "pendingAction" | "status">,
): boolean {
  if (session.pendingAction) return false;
  return session.status === "offline" || session.status === "exited";
}

export function isDesktopServiceOffline(
  service: Pick<DesktopService, "pendingAction" | "status">,
): boolean {
  if (service.pendingAction) return false;
  return service.status === "offline" || service.status === "exited";
}

export function filterWorktreeBucketToActiveEntries(bucket: WorktreeBucket): WorktreeBucket | null {
  const sessions = bucket.sessions.filter((session) => !isDesktopSessionOffline(session));
  const services = bucket.services.filter((service) => !isDesktopServiceOffline(service));
  const keepOperational = Boolean(bucket.pending || bucket.removing);
  if (sessions.length === 0 && services.length === 0 && !keepOperational) return null;
  return { ...bucket, sessions, services };
}

function isDashboardHiddenSession(session: DesktopSession): boolean {
  return session.overseer === true || session.team?.role === "overseer";
}

function bucketFromServerGroup(group: DesktopWorktreeGroup): WorktreeBucket {
  const isMainCheckout = !group.path;
  return {
    key: group.path ?? MAIN_CHECKOUT_KEY,
    name: group.name,
    branch: group.branch,
    path: group.path ?? null,
    isMainCheckout,
    pending: group.pending,
    removing: group.removing,
    sessions: group.sessions.filter((session) => !isDashboardHiddenSession(session)),
    services: group.services,
  };
}

// Prefer the server-composed worktree groups: they are the same dashboard model
// the TUI renders. The regrouping path below is only for older desktop-state
// payloads that do not include worktreeGroups.
export function groupByWorktree(state: DesktopState): WorktreeBucket[] {
  if (Array.isArray(state.worktreeGroups)) {
    return state.worktreeGroups.map(bucketFromServerGroup);
  }

  const buckets = new Map<string, WorktreeBucket>();
  const mainPath = state.mainCheckoutPath;

  const mainBucket: WorktreeBucket = {
    key: MAIN_CHECKOUT_KEY,
    name: state.mainCheckoutInfo?.name ?? "Main Checkout",
    branch: state.mainCheckoutInfo?.branch ?? "",
    path: mainPath ?? null,
    isMainCheckout: true,
    sessions: [],
    services: [],
  };
  buckets.set(MAIN_CHECKOUT_KEY, mainBucket);

  for (const wt of state.worktrees) {
    if (mainPath && wt.path === mainPath) continue;
    buckets.set(wt.path, {
      key: wt.path,
      name: wt.name,
      branch: wt.branch,
      path: wt.path,
      isMainCheckout: false,
      pending: wt.pending,
      removing: wt.removing,
      sessions: [],
      services: [],
    });
  }

  function bucketFor(worktreePath?: string): WorktreeBucket {
    if (!worktreePath) return mainBucket;
    if (mainPath && worktreePath === mainPath) return mainBucket;
    const existing = buckets.get(worktreePath);
    if (existing) return existing;
    // Unknown worktree — synthesize a bucket so the entry is still rendered.
    const fallback: WorktreeBucket = {
      key: worktreePath,
      name: worktreePath.split(/[\\/]/).pop() ?? worktreePath,
      branch: "",
      path: worktreePath,
      isMainCheckout: false,
      sessions: [],
      services: [],
    };
    buckets.set(worktreePath, fallback);
    return fallback;
  }

  for (const session of state.sessions) {
    if (isDashboardHiddenSession(session)) continue;
    bucketFor(session.worktreePath).sessions.push(session);
  }
  for (const service of state.services) {
    bucketFor(service.worktreePath).services.push(service);
  }

  const ordered: WorktreeBucket[] = [];
  ordered.push(mainBucket);
  for (const wt of state.worktrees) {
    if (mainPath && wt.path === mainPath) continue;
    const bucket = buckets.get(wt.path);
    if (bucket) ordered.push(bucket);
  }
  // Any synthesized fallback buckets not in the server's worktrees list — append last.
  for (const bucket of buckets.values()) {
    if (ordered.includes(bucket)) continue;
    ordered.push(bucket);
  }
  return ordered;
}
