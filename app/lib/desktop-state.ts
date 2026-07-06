// Client-side types for the per-project metadata server's GET /desktop-state response,
// plus a lean group-by-worktree helper that mirrors the TUI's dashboard hierarchy.
// Canonical server-side shapes live in src/dashboard/index.ts and src/multiplexer/dashboard-model.ts.

export type DesktopSessionStatus = "running" | "idle" | "waiting" | "exited" | "offline";
export type DesktopServiceStatus = "running" | "exited" | "offline";

export interface DesktopSession {
  id: string;
  command?: string;
  toolConfigKey?: string;
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
  optimistic?: boolean;
}

export interface DesktopService {
  id: string;
  command?: string;
  args?: string[];
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

// Group sessions + services into the same worktree-keyed buckets the TUI renders.
// Main-checkout bucket holds anything without a worktreePath OR whose path matches
// `state.mainCheckoutPath`. Other buckets come from `state.worktrees`, in the order
// the server returned them. Any session/service with an unknown worktreePath falls
// into a synthesized bucket so it isn't lost.
export function groupByWorktree(state: DesktopState): WorktreeBucket[] {
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
