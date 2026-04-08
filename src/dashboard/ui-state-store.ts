import { readFileSync, writeFileSync } from "node:fs";
import type { DashboardSession } from "./index.js";
import { type DashboardScreen, type DashboardState } from "./state.js";
import { getDashboardUiStatePath } from "../paths.js";

interface DashboardUiStateSnapshot {
  screen?: DashboardScreen;
  detailsSidebarVisible?: boolean;
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

  loadInto(state: DashboardState): void {
    try {
      const raw = readFileSync(getDashboardUiStatePath(), "utf-8");
      const snapshot = JSON.parse(raw) as DashboardUiStateSnapshot;
      if (snapshot.screen) {
        state.screen = snapshot.screen;
      }
      if (typeof snapshot.detailsSidebarVisible === "boolean") {
        state.detailsSidebarVisible = snapshot.detailsSidebarVisible;
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
      }
      if (snapshot.flatSessionId) {
        this.flatSessionId = snapshot.flatSessionId;
      }
    } catch {}
  }

  persist(
    mode: "dashboard" | "project-service",
    state: DashboardState,
    activeIndex: number,
    dashSessions: DashboardSession[],
  ): void {
    if (mode !== "dashboard") return;
    const snapshot: DashboardUiStateSnapshot = {
      screen: state.screen,
      detailsSidebarVisible: state.detailsSidebarVisible,
      focusedWorktreePath: state.focusedWorktreePath,
      level: state.level,
    };

    if (state.level === "sessions" && state.worktreeEntries.length > 0) {
      const selectedEntry = state.worktreeEntries[state.sessionIndex];
      if (selectedEntry) {
        snapshot.selectedEntryKind = selectedEntry.kind;
        snapshot.selectedEntryId = selectedEntry.id;
        this.preferredSelection = {
          kind: selectedEntry.kind,
          id: selectedEntry.id,
        };
      }
    }

    const flatSession = dashSessions[activeIndex];
    if (flatSession) {
      snapshot.flatSessionId = flatSession.id;
      this.flatSessionId = flatSession.id;
    }

    try {
      writeFileSync(getDashboardUiStatePath(), JSON.stringify(snapshot, null, 2) + "\n");
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
    updateWorktreeSessions: () => void,
    activeIndex: number,
    setActiveIndex: (value: number) => void,
  ): void {
    if (!this.selectionNeedsRestore) return;
    if (hasWorktrees) {
      updateWorktreeSessions();
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
}
