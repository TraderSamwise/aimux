import type { DashboardSession, DashboardWorktreeEntry } from "./index.js";

export type DashboardScreen = "dashboard" | "activity" | "workflow" | "threads" | "plans" | "graveyard" | "help";
export type DashboardLevel = "worktrees" | "sessions";

export class DashboardState {
  screen: DashboardScreen = "dashboard";
  detailsSidebarVisible = true;
  focusedWorktreePath: string | undefined = undefined;
  worktreeNavOrder: Array<string | undefined> = [];
  level: DashboardLevel = "worktrees";
  sessionIndex = 0;
  worktreeSessions: DashboardSession[] = [];
  worktreeEntries: DashboardWorktreeEntry[] = [];
  quickJumpDigits = "";

  isScreen(screen: DashboardScreen): boolean {
    return this.screen === screen;
  }

  setScreen(screen: DashboardScreen): void {
    this.screen = screen;
  }

  resetSubscreen(): void {
    this.screen = "dashboard";
  }

  toggleDetailsSidebar(): void {
    this.detailsSidebarVisible = !this.detailsSidebarVisible;
  }

  hasWorktrees(): boolean {
    return this.worktreeNavOrder.length > 1;
  }
}
