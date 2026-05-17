import type { DashboardService, DashboardSession, WorktreeGroup } from "./index.js";

export const MAIN_CHECKOUT_ORDER_KEY = "__main__";

export interface DashboardOrderState {
  agentOrderByWorktreeKey: Record<string, string[]>;
  serviceOrderByWorktreeKey: Record<string, string[]>;
}

export type DashboardOrderKind = "session" | "service";
export type DashboardOrderDirection = "up" | "down";

export function dashboardOrderKey(worktreePath: string | undefined): string {
  return worktreePath ?? MAIN_CHECKOUT_ORDER_KEY;
}

export function normalizeDashboardOrder(currentIds: string[], savedOrder: string[] | undefined): string[] {
  const current = new Set(currentIds);
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const id of savedOrder ?? []) {
    if (!current.has(id) || seen.has(id)) continue;
    normalized.push(id);
    seen.add(id);
  }

  for (const id of currentIds) {
    if (seen.has(id)) continue;
    normalized.push(id);
    seen.add(id);
  }

  return normalized;
}

export function applyDashboardOrder<T extends { id: string }>(items: T[], savedOrder: string[] | undefined): T[] {
  const order = normalizeDashboardOrder(
    items.map((item) => item.id),
    savedOrder,
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  return order.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
}

export function moveDashboardOrder<T extends { id: string }>(
  items: T[],
  savedOrder: string[] | undefined,
  selectedId: string,
  direction: DashboardOrderDirection,
): { moved: boolean; order: string[] } {
  const order = normalizeDashboardOrder(
    items.map((item) => item.id),
    savedOrder,
  );
  const index = order.indexOf(selectedId);
  if (index < 0) return { moved: false, order };
  const nextIndex = direction === "up" ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= order.length) return { moved: false, order };
  [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
  return { moved: true, order };
}

export function orderDashboardWorktreeGroups(
  groups: WorktreeGroup[],
  orderState: DashboardOrderState,
): WorktreeGroup[] {
  return groups.map((group) => {
    const key = dashboardOrderKey(group.path);
    return {
      ...group,
      sessions: applyDashboardOrder(group.sessions, orderState.agentOrderByWorktreeKey[key]),
      services: applyDashboardOrder(group.services, orderState.serviceOrderByWorktreeKey[key]),
    };
  });
}

export function orderDashboardSessionsForWorktree(
  sessions: DashboardSession[],
  worktreePath: string | undefined,
  orderState: DashboardOrderState,
): DashboardSession[] {
  return applyDashboardOrder(sessions, orderState.agentOrderByWorktreeKey[dashboardOrderKey(worktreePath)]);
}

export function orderDashboardServicesForWorktree(
  services: DashboardService[],
  worktreePath: string | undefined,
  orderState: DashboardOrderState,
): DashboardService[] {
  return applyDashboardOrder(services, orderState.serviceOrderByWorktreeKey[dashboardOrderKey(worktreePath)]);
}
