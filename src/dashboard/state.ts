import type { DashboardSession, DashboardWorktreeEntry } from "./index.js";

export type DashboardScreen =
  | "dashboard"
  | "activity"
  | "workflow"
  | "threads"
  | "notifications"
  | "plans"
  | "graveyard"
  | "help";
export type DashboardLevel = "worktrees" | "sessions";
export type DashboardOverlayKind =
  | "none"
  | "tool-picker"
  | "worktree-input"
  | "service-input"
  | "label-input"
  | "orchestration-input"
  | "orchestration-route-picker"
  | "worktree-list"
  | "worktree-remove-confirm"
  | "migrate-picker"
  | "thread-reply"
  | "notification-panel"
  | "switcher";

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
    return this.worktreeNavOrder.length > 0;
  }

  renderStateKey(): string {
    return [
      this.screen,
      this.detailsSidebarVisible ? "details:1" : "details:0",
      `focus:${this.focusedWorktreePath ?? "__main__"}`,
      `order:${this.worktreeNavOrder.join(",")}`,
      `level:${this.level}`,
      `index:${this.sessionIndex}`,
      `sessions:${this.worktreeSessions.length}`,
      `entries:${this.worktreeEntries.length}`,
      `quick:${this.quickJumpDigits}`,
    ].join("|");
  }
}

export class DashboardOverlayState {
  kind: DashboardOverlayKind = "none";
  version = 0;

  is(kind: DashboardOverlayKind): boolean {
    return this.kind === kind;
  }

  open(kind: Exclude<DashboardOverlayKind, "none">): void {
    if (this.kind === kind) return;
    this.kind = kind;
    this.version += 1;
  }

  clear(): void {
    if (this.kind === "none") return;
    this.kind = "none";
    this.version += 1;
  }
}
