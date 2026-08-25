export const VISUAL_CLIENT_LEASE_MS = 15_000;
export const VISUAL_CLIENT_LEASE_MIN_MS = 1_000;
export const VISUAL_CLIENT_LEASE_MAX_MS = 60_000;

export const VISUAL_CLIENT_KINDS = ["tui", "web", "mobile", "expose", "api"] as const;
export type VisualClientKind = (typeof VISUAL_CLIENT_KINDS)[number];

export interface VisualClientLease {
  id: string;
  kind: VisualClientKind;
  surface: string;
  requestedPreview: boolean;
  requestedChatPreview: boolean;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface VisualClientLeaseSnapshot {
  active: VisualClientLease[];
  counts: Record<VisualClientKind, number>;
  activePreviewClients: number;
}

export interface VisualClientLeaseInput {
  id?: string | null;
  kind?: string | null;
  surface: string;
  requestedPreview?: boolean;
  requestedChatPreview?: boolean;
  ttlMs?: number | string | null;
}

export class VisualClientLeaseRegistry {
  private readonly now: () => Date;
  private readonly leases = new Map<string, VisualClientLease>();

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  touch(input: VisualClientLeaseInput): VisualClientLease {
    const now = this.now();
    this.prune(now.getTime());
    const kind = parseVisualClientKind(input.kind);
    const surface = sanitizeLeasePart(input.surface) || "unknown";
    const id = sanitizeLeasePart(input.id) || `${kind}:${surface}:anonymous`;
    const key = `${kind}:${surface}:${id}`;
    const current = this.leases.get(key);
    const ttlMs = clampLeaseTtl(input.ttlMs);
    const lease: VisualClientLease = {
      id,
      kind,
      surface,
      requestedPreview: input.requestedPreview === true,
      requestedChatPreview: input.requestedChatPreview === true,
      startedAt: current?.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.leases.set(key, lease);
    return lease;
  }

  snapshot(): VisualClientLeaseSnapshot {
    this.prune(this.now().getTime());
    const counts = emptyCounts();
    let activePreviewClients = 0;
    const active = [...this.leases.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    for (const lease of active) {
      counts[lease.kind] += 1;
      if (lease.requestedPreview || lease.requestedChatPreview) activePreviewClients += 1;
    }
    return { active, counts, activePreviewClients };
  }

  hasActivePreviewClients(): boolean {
    this.prune(this.now().getTime());
    for (const lease of this.leases.values()) {
      if (lease.requestedPreview || lease.requestedChatPreview) return true;
    }
    return false;
  }

  private prune(nowMs: number): void {
    for (const [key, lease] of this.leases) {
      const expiresAt = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) this.leases.delete(key);
    }
  }
}

export function parseVisualClientKind(value: string | null | undefined): VisualClientKind {
  return VISUAL_CLIENT_KINDS.includes(value as VisualClientKind) ? (value as VisualClientKind) : "api";
}

function emptyCounts(): Record<VisualClientKind, number> {
  return { tui: 0, web: 0, mobile: 0, expose: 0, api: 0 };
}

function clampLeaseTtl(value: number | string | null | undefined): number {
  const raw = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(raw)) return VISUAL_CLIENT_LEASE_MS;
  return Math.min(VISUAL_CLIENT_LEASE_MAX_MS, Math.max(VISUAL_CLIENT_LEASE_MIN_MS, Math.floor(raw as number)));
}

function sanitizeLeasePart(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:@/-]/g, "-")
    .slice(0, 120);
}
