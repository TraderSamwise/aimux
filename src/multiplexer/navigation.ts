import { findMainRepo, listWorktrees as listAllWorktrees } from "../worktree.js";
import { parseKeys } from "../key-parser.js";
import {
  renderHelpOverlay,
  renderMigratePickerOverlay,
  renderSwitcherOverlay,
} from "../tui/screens/overlay-renderers.js";

type NavigationHost = any;

export function getSwitcherList(host: NavigationHost): any[] {
  const alive = host
    .getScopedSessionEntries()
    .map(({ session }: { session: any }) => session)
    .filter((s: any) => !s.exited);
  const ordered: any[] = [];
  for (const id of host.sessionMRU) {
    const session = alive.find((candidate: any) => candidate.id === id);
    if (session) ordered.push(session);
  }
  for (const session of alive) {
    if (!ordered.includes(session)) ordered.push(session);
  }
  return ordered;
}

export function showSwitcher(host: NavigationHost): void {
  const list = getSwitcherList(host);
  if (list.length < 2) return;

  host.switcherActive = true;
  host.switcherIndex = 1;
  renderSwitcher(host);
  resetSwitcherTimeout(host);
}

export function resetSwitcherTimeout(host: NavigationHost): void {
  if (host.switcherTimeout) clearTimeout(host.switcherTimeout);
  host.switcherTimeout = setTimeout(() => {
    confirmSwitcher(host);
  }, 1000);
}

export function confirmSwitcher(host: NavigationHost): void {
  if (host.switcherTimeout) {
    clearTimeout(host.switcherTimeout);
    host.switcherTimeout = null;
  }
  host.switcherActive = false;

  const list = getSwitcherList(host);
  const target = list[host.switcherIndex];
  if (target) {
    const idx = host.sessions.indexOf(target);
    if (idx >= 0) host.focusSession(idx);
  }
}

export function dismissSwitcher(host: NavigationHost): void {
  if (host.switcherTimeout) {
    clearTimeout(host.switcherTimeout);
    host.switcherTimeout = null;
  }
  host.switcherActive = false;
  host.renderDashboard();
}

export function redrawCurrentView(host: NavigationHost): void {
  host.renderDashboard();
}

export function showHelp(host: NavigationHost): void {
  host.clearDashboardSubscreens();
  host.invalidateDashboardFrame();
  host.setDashboardScreen("help");
  host.writeStatuslineFile();
  renderHelp(host);
}

export function dismissHelp(host: NavigationHost): void {
  host.setDashboardScreen("dashboard");
  redrawCurrentView(host);
}

export function renderHelp(host: NavigationHost): void {
  renderHelpOverlay(host);
}

export function handleHelpKey(host: NavigationHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;

  if (key === "q") {
    host.exitDashboardClientOrProcess();
    return;
  }
  if (key === "escape" || key === "enter" || key === "return" || key === "d") {
    dismissHelp(host);
    return;
  }
  if (key === "p") {
    dismissHelp(host);
    host.showPlans();
    return;
  }
  if (key === "a") {
    dismissHelp(host);
    host.showActivityDashboard();
    return;
  }
  if (key === "y") {
    dismissHelp(host);
    host.showWorkflow();
    return;
  }
  if (key === "g") {
    dismissHelp(host);
    host.showGraveyard();
    return;
  }
  if (key === "?") {
    dismissHelp(host);
  }
}

export function renderSwitcher(host: NavigationHost): void {
  renderSwitcherOverlay(host);
}

export function handleSwitcherKey(host: NavigationHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;

  if (key === "s") {
    const list = getSwitcherList(host);
    host.switcherIndex = (host.switcherIndex + 1) % list.length;
    renderSwitcher(host);
    resetSwitcherTimeout(host);
    return;
  }

  if (key === "return" || key === "enter") {
    confirmSwitcher(host);
    return;
  }

  if (key === "escape") {
    dismissSwitcher(host);
    return;
  }

  if (key === "x") {
    const list = getSwitcherList(host);
    const target = list[host.switcherIndex];
    if (!target) return;
    dismissSwitcher(host);
    void host.stopSessionToOfflineWithFeedback(target);
    return;
  }

  dismissSwitcher(host);
}

export function showMigratePicker(host: NavigationHost): void {
  try {
    const worktrees = listAllWorktrees();
    const mainRepo = findMainRepo();
    host.migratePickerWorktrees = [
      { name: "(main)", path: mainRepo },
      ...worktrees.filter((wt) => wt.path !== mainRepo).map((wt) => ({ name: wt.name, path: wt.path })),
    ];
  } catch {
    host.migratePickerWorktrees = [];
  }

  if (host.migratePickerWorktrees.length <= 1) return;

  host.migratePickerActive = true;
  renderMigratePicker(host);
}

export function renderMigratePicker(host: NavigationHost): void {
  renderMigratePickerOverlay(host);
}

export function handleMigratePickerKey(host: NavigationHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;

  host.migratePickerActive = false;

  if (key === "escape") {
    if (host.mode === "dashboard") {
      host.renderDashboard();
    } else {
      host.focusSession(host.activeIndex);
    }
    return;
  }

  if (key >= "1" && key <= "9") {
    const idx = parseInt(key) - 1;
    if (idx < host.migratePickerWorktrees.length) {
      const target = host.migratePickerWorktrees[idx];
      const session = host.sessions[host.activeIndex];
      if (session) {
        void host.migrateSessionWithFeedback(session, target.path, target.name);
        return;
      }
    }
  }

  if (host.mode === "dashboard") {
    host.renderDashboard();
  } else if (host.sessions.length > 0) {
    host.focusSession(host.activeIndex);
  }
}
