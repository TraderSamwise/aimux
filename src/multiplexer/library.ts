import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { parseKeys } from "../key-parser.js";
import { loadLibraryEntries } from "../library.js";
import { getPlansDir } from "../paths.js";
import { renderLibraryScreen } from "../tui/screens/subscreen-renderers.js";

type LibraryHost = any;

function refreshLibrary(host: LibraryHost): void {
  const plansDir = getPlansDir();
  host.libraryEntries = loadLibraryEntries({
    repoRoot: dirname(dirname(plansDir)),
    plansDir,
    resolveLabel: (id: string) => host.getSessionLabel(id),
  });
  if (typeof host.libraryIndex !== "number" || Number.isNaN(host.libraryIndex)) host.libraryIndex = 0;
  if (host.libraryIndex >= host.libraryEntries.length) {
    host.libraryIndex = Math.max(0, host.libraryEntries.length - 1);
  }
}

export function showLibrary(host: LibraryHost): void {
  host.clearDashboardSubscreens();
  refreshLibrary(host);
  host.setDashboardScreen("library");
  host.writeStatuslineFile();
  renderLibrary(host);
}

export function renderLibrary(host: LibraryHost): void {
  if (!Array.isArray(host.libraryEntries)) refreshLibrary(host);
  renderLibraryScreen(host);
}

function openEntryInEditor(host: LibraryHost, path: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || "vim";
  const shell = process.env.SHELL || "/bin/zsh";
  const shellEscape = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

  host.terminalHost.exitRawMode();
  host.terminalHost.exitAlternateScreen();

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(shell, ["-lc", `${editor} ${shellEscape(path)}`], { stdio: "inherit" });
  } finally {
    host.terminalHost.enterRawMode();
    host.terminalHost.enterAlternateScreen(true);
  }

  if (result.error) {
    host.dashboardErrorState = {
      title: `Failed to open editor "${editor}"`,
      lines: [result.error.message],
    };
  }

  refreshLibrary(host);
  renderLibrary(host);
  if (host.dashboardErrorState) {
    host.renderDashboardErrorOverlay();
  }
}

export function handleLibraryKey(host: LibraryHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderLibrary(host);
    return;
  }
  if (key === "q") {
    host.exitDashboardClientOrProcess();
    return;
  }
  if (key === "escape" || key === "d") {
    host.setDashboardScreen("dashboard");
    host.renderDashboard();
    return;
  }
  if (host.handleDashboardSubscreenNavigationKey(key, "library")) return;
  if (key === "?") {
    host.showHelp();
    return;
  }
  if (key === "r") {
    refreshLibrary(host);
    renderLibrary(host);
    return;
  }
  const entries = host.libraryEntries ?? [];
  if (key === "down" || key === "j") {
    if (entries.length > 1) {
      host.libraryIndex = (host.libraryIndex + 1) % entries.length;
      renderLibrary(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (entries.length > 1) {
      host.libraryIndex = (host.libraryIndex - 1 + entries.length) % entries.length;
      renderLibrary(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < entries.length) {
      host.libraryIndex = idx;
      renderLibrary(host);
    }
    return;
  }
  if (key === "e" || key === "enter" || key === "return") {
    const selected = entries[host.libraryIndex];
    if (selected) openEntryInEditor(host, selected.path);
  }
}
