import { spawnSync } from "node:child_process";
import { commandKey, parseKeys } from "../key-parser.js";
import type { LibraryEntry } from "../library.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { renderLibraryScreen } from "../tui/screens/subscreen-renderers.js";
import { refreshDashboardApiResource } from "./dashboard-api-client.js";
import { startDashboardLifecycleTask, type DashboardApiViewRefreshOptions } from "./dashboard-lifecycle.js";

type LibraryHost = any;
const LIBRARY_RESOURCE = "library";

function isLibraryEntry(value: any): value is LibraryEntry {
  return (
    Boolean(value) &&
    typeof value.id === "string" &&
    (value.kind === "doc" || value.kind === "plan") &&
    typeof value.title === "string" &&
    typeof value.path === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.preview === "string" &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.label === undefined || typeof value.label === "string")
  );
}

function applyLibraryEntries(host: LibraryHost, entries: LibraryEntry[]): void {
  host.libraryEntries = entries;
  host.libraryLoaded = true;
  if (typeof host.libraryIndex !== "number" || Number.isNaN(host.libraryIndex)) host.libraryIndex = 0;
  if (host.libraryIndex < 0) host.libraryIndex = 0;
  if (host.libraryIndex >= host.libraryEntries.length) {
    host.libraryIndex = Math.max(0, host.libraryEntries.length - 1);
  }
}

function ensureLibraryEntries(host: LibraryHost): void {
  if (!host.libraryLoaded) applyLibraryEntries(host, []);
}

function validateLibraryPayload(value: unknown): LibraryEntry[] {
  const res = value as any;
  if (!res?.ok || !Array.isArray(res.entries) || !res.entries.every(isLibraryEntry)) {
    throw new Error("invalid library payload");
  }
  return res.entries;
}

export async function refreshLibrary(
  host: LibraryHost,
  options: DashboardApiViewRefreshOptions = {},
): Promise<boolean> {
  return refreshDashboardApiResource(
    host,
    {
      resource: LIBRARY_RESOURCE,
      path: PROJECT_API_ROUTES.library,
      validate: validateLibraryPayload,
      apply: (entries) => applyLibraryEntries(host, entries),
      ensure: () => ensureLibraryEntries(host),
    },
    options,
  );
}

export function showLibrary(host: LibraryHost): void {
  host.clearDashboardSubscreens();
  ensureLibraryEntries(host);
  host.setDashboardScreen("library");
  host.writeStatuslineFile();
  renderLibrary(host);
  startDashboardLifecycleTask(host, { screen: "library" }, (lifecycle) => refreshLibrary(host, { lifecycle }), {
    onSuccess: (refreshed) => {
      if (refreshed) renderLibrary(host);
    },
  });
}

export function renderLibrary(host: LibraryHost): void {
  ensureLibraryEntries(host);
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

  startDashboardLifecycleTask(
    host,
    { screen: "library" },
    (lifecycle) => refreshLibrary(host, { force: true, lifecycle }),
    {
      onSuccess: () => renderLibrary(host),
    },
  );
  if (!host.isDashboardScreen || host.isDashboardScreen("library")) renderLibrary(host);
  if (host.dashboardErrorState) {
    host.renderDashboardErrorOverlay();
  }
}

export function handleLibraryKey(host: LibraryHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = commandKey(event);
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
  if (host.handleDashboardSubscreenNavigationKey(key, "library", event)) return;
  if (key === "?") {
    host.showHelp();
    return;
  }
  if (key === "r") {
    startDashboardLifecycleTask(
      host,
      { screen: "library" },
      (lifecycle) => refreshLibrary(host, { force: true, lifecycle }),
      {
        onSuccess: () => renderLibrary(host),
      },
    );
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
