import { readFileSync, writeFileSync } from "node:fs";
import type { DashboardService, DashboardSession, WorktreeGroup } from "./index.js";
import {
  dashboardOrderKey,
  moveDashboardOrder,
  orderDashboardServicesForWorktree,
  orderDashboardSessionsForWorktree,
  orderDashboardWorktreeGroups,
  type DashboardOrderDirection,
  type DashboardOrderKind,
  type DashboardOrderState,
} from "./order.js";
import { type DashboardScreen, type DashboardState } from "./state.js";
import { getDashboardClientUiStatePath, getDashboardUiStatePath } from "../paths.js";

interface DashboardUiSharedSnapshot {
  detailsSidebarVisible?: boolean;
  agentOrderByWorktreeKey?: Record<string, string[]>;
  serviceOrderByWorktreeKey?: Record<string, string[]>;
}

interface DashboardUiClientSnapshot {
  screen?: DashboardScreen;
  focusedWorktreePath?: string;
  level?: "worktrees" | "sessions";
  selectedEntryKind?: "session" | "service";
  selectedEntryId?: string;
  flatSessionId?: string;
}

export class DashboardUiStateStore {
  private preferredSelection: { kind: "session" | "service"; id: string } | null = null;
  private flatSessionId: string | null = null;
  private selectionNeedsRestore = true;
  private orderState: DashboardOrderState = {
    agentOrderByWorktreeKey: {},
    serviceOrderByWorktreeKey: {},
  };

  loadSharedState(state?: DashboardState): void {
    try {
      const raw = readFileSync(getDashboardUiStatePath(), "utf-8");
      const snapshot = JSON.parse(raw) as DashboardUiSharedSnapshot;
      if (state && typeof snapshot.detailsSidebarVisible === "boolean") {
        state.detailsSidebarVisible = snapshot.detailsSidebarVisible;
      }
      this.orderState = {
        agentOrderByWorktreeKey: sanitizeOrderMap(snapshot.agentOrderByWorktreeKey),
        serviceOrderByWorktreeKey: sanitizeOrderMap(snapshot.serviceOrderByWorktreeKey),
      };
    } catch {}
  }

  loadInto(state: DashboardState, clientKey: string): void {
    this.loadSharedState(state);
    try {
      const raw = readFileSync(getDashboardClientUiStatePath(clientKey), "utf-8");
      const snapshot = JSON.parse(raw) as DashboardUiClientSnapshot;
      if (snapshot.screen) {
        state.screen = snapshot.screen;
      }
      if ("focusedWorktreePath" in snapshot) {
        state.focusedWorktreePath = snapshot.focusedWorktreePath;
      }
      if (snapshot.level) {
        state.level = snapshot.level;
      }
      if (snapshot.selectedEntryKind && snapshot.selectedEntryId) {
        this.preferredSelection = {
          kind: snapshot.selectedEntryKind,
          id: snapshot.selectedEntryId,
        };
        this.selectionNeedsRestore = true;
      }
      if (snapshot.flatSessionId) {
        this.flatSessionId = snapshot.flatSessionId;
        this.selectionNeedsRestore = true;
      }
    } catch {}
  }

  persist(
    mode: "dashboard" | "project-service",
    clientKey: string,
    state: DashboardState,
    activeIndex: number,
    dashSessions: DashboardSession[],
  ): void {
    if (mode !== "dashboard") return;
    const sharedSnapshot: DashboardUiSharedSnapshot = {
      detailsSidebarVisible: state.detailsSidebarVisible,
      ...(hasOrderEntries(this.orderState.agentOrderByWorktreeKey)
        ? { agentOrderByWorktreeKey: this.orderState.agentOrderByWorktreeKey }
        : {}),
      ...(hasOrderEntries(this.orderState.serviceOrderByWorktreeKey)
        ? { serviceOrderByWorktreeKey: this.orderState.serviceOrderByWorktreeKey }
        : {}),
    };
    const clientSnapshot: DashboardUiClientSnapshot = {
      screen: state.screen,
      focusedWorktreePath: state.focusedWorktreePath,
      level: state.level,
    };

    if (state.level === "sessions" && state.worktreeEntries.length > 0) {
      const selectedEntry = state.worktreeEntries[state.sessionIndex];
      if (selectedEntry) {
        clientSnapshot.selectedEntryKind = selectedEntry.kind;
        clientSnapshot.selectedEntryId = selectedEntry.id;
        this.preferredSelection = {
          kind: selectedEntry.kind,
          id: selectedEntry.id,
        };
      }
    }

    const flatSession = dashSessions[activeIndex];
    if (flatSession) {
      clientSnapshot.flatSessionId = flatSession.id;
      this.flatSessionId = flatSession.id;
    }

    try {
      writeFileSync(getDashboardUiStatePath(), JSON.stringify(sharedSnapshot, null, 2) + "\n");
      writeFileSync(getDashboardClientUiStatePath(clientKey), JSON.stringify(clientSnapshot, null, 2) + "\n");
    } catch {}
  }

  preferEntrySelection(state: DashboardState, kind: "session" | "service", id: string, worktreePath?: string): void {
    state.level = "sessions";
    state.focusedWorktreePath = worktreePath;
    this.preferredSelection = { kind, id };
    this.selectionNeedsRestore = true;
  }

  markSelectionDirty(): void {
    this.selectionNeedsRestore = true;
  }

  consumeSelectionRestore(
    state: DashboardState,
    dashSessions: DashboardSession[],
    hasWorktrees: boolean,
    activeIndex: number,
    setActiveIndex: (value: number) => void,
  ): void {
    if (!this.selectionNeedsRestore) return;
    if (hasWorktrees) {
      if (state.level === "sessions" && this.preferredSelection) {
        const preferredIndex = state.worktreeEntries.findIndex(
          (entry) => entry.kind === this.preferredSelection?.kind && entry.id === this.preferredSelection?.id,
        );
        if (preferredIndex >= 0) {
          state.sessionIndex = preferredIndex;
        } else if (state.sessionIndex >= state.worktreeEntries.length) {
          state.sessionIndex = Math.max(0, state.worktreeEntries.length - 1);
        }
      }
      this.selectionNeedsRestore = false;
      return;
    }

    if (this.flatSessionId) {
      const preferredIndex = dashSessions.findIndex((session) => session.id === this.flatSessionId);
      if (preferredIndex >= 0) {
        setActiveIndex(preferredIndex);
      } else if (activeIndex >= dashSessions.length) {
        setActiveIndex(Math.max(0, dashSessions.length - 1));
      }
    } else if (activeIndex >= dashSessions.length) {
      setActiveIndex(Math.max(0, dashSessions.length - 1));
    }
    this.selectionNeedsRestore = false;
  }

  getOrderState(): DashboardOrderState {
    return {
      agentOrderByWorktreeKey: { ...this.orderState.agentOrderByWorktreeKey },
      serviceOrderByWorktreeKey: { ...this.orderState.serviceOrderByWorktreeKey },
    };
  }

  orderWorktreeGroups(groups: WorktreeGroup[]): WorktreeGroup[] {
    return orderDashboardWorktreeGroups(groups, this.orderState);
  }

  orderSessionsForWorktree(sessions: DashboardSession[], worktreePath: string | undefined): DashboardSession[] {
    return orderDashboardSessionsForWorktree(sessions, worktreePath, this.orderState);
  }

  orderServicesForWorktree(services: DashboardService[], worktreePath: string | undefined): DashboardService[] {
    return orderDashboardServicesForWorktree(services, worktreePath, this.orderState);
  }

  moveEntryWithinWorktree(input: {
    kind: DashboardOrderKind;
    worktreePath: string | undefined;
    selectedId: string;
    direction: DashboardOrderDirection;
    sessions: DashboardSession[];
    services: DashboardService[];
  }): boolean {
    const key = dashboardOrderKey(input.worktreePath);
    if (input.kind === "session") {
      const result = moveDashboardOrder(
        input.sessions,
        this.orderState.agentOrderByWorktreeKey[key],
        input.selectedId,
        input.direction,
      );
      this.orderState.agentOrderByWorktreeKey = {
        ...this.orderState.agentOrderByWorktreeKey,
        [key]: result.order,
      };
      return result.moved;
    }

    const result = moveDashboardOrder(
      input.services,
      this.orderState.serviceOrderByWorktreeKey[key],
      input.selectedId,
      input.direction,
    );
    this.orderState.serviceOrderByWorktreeKey = {
      ...this.orderState.serviceOrderByWorktreeKey,
      [key]: result.order,
    };
    return result.moved;
  }
}

function sanitizeOrderMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(value)) {
    if (!Array.isArray(ids)) continue;
    const cleanIds = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (cleanIds.length > 0) {
      output[key] = cleanIds;
    }
  }
  return output;
}

function hasOrderEntries(value: Record<string, string[]>): boolean {
  return Object.values(value).some((ids) => ids.length > 0);
}
