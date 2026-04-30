import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { getGraveyardPath, getPlansDir } from "../paths.js";
import { debug } from "../debug.js";
import { parseKeys } from "../key-parser.js";
import {
  renderGraveyardDetails,
  renderGraveyardScreen,
  renderPlanDetails,
  renderPlansScreen,
} from "../tui/screens/subscreen-renderers.js";
import { listWorktreeGraveyardEntries, type WorktreeGraveyardEntry } from "./worktree-graveyard.js";
import { postToProjectService } from "./dashboard-control.js";
import { requestJson } from "../http-client.js";
import { resolveProjectServiceEndpoint } from "../metadata-store.js";

type ArchivesHost = any;

type GraveyardItem = { kind: "worktree"; entry: WorktreeGraveyardEntry } | { kind: "agent"; entry: any };

export function showGraveyard(host: ArchivesHost): void {
  host.clearDashboardSubscreens();
  loadGraveyardEntries(host);
  host.graveyardWorktreeDeleteConfirm = null;
  clampGraveyardSelection(host);
  host.setDashboardScreen("graveyard");
  host.writeStatuslineFile();
  renderGraveyard(host);
  if (host.mode === "dashboard") {
    void refreshGraveyardEntriesFromService(host);
  }
}

export function hydrateDashboardArchiveScreenState(host: ArchivesHost): void {
  if (host.isDashboardScreen?.("graveyard")) {
    loadGraveyardEntries(host);
    if (host.mode === "dashboard") {
      void refreshGraveyardEntriesFromService(host);
    }
    return;
  }
  if (host.isDashboardScreen?.("plans")) {
    loadPlanEntries(host);
  }
}

export function renderGraveyard(host: ArchivesHost): void {
  renderGraveyardScreen(host);
}

export function handleGraveyardKey(host: ArchivesHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderGraveyard(host);
    return;
  }

  if (host.graveyardWorktreeDeleteConfirm) {
    if (key === "escape" || key === "n") {
      host.graveyardWorktreeDeleteConfirm = null;
      renderGraveyard(host);
      return;
    }
    if (key === "y" || key === "enter" || key === "return") {
      void deleteSelectedGraveyardWorktree(host);
      return;
    }
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
  if (host.handleDashboardSubscreenNavigationKey(key, "graveyard")) return;

  if (key === "?") {
    host.showHelp();
    return;
  }

  if (key === "down" || key === "j") {
    const items = getGraveyardItems(host);
    if (items.length > 1) {
      host.graveyardIndex = (host.graveyardIndex + 1) % items.length;
      renderGraveyard(host);
    }
    return;
  }

  if (key === "up" || key === "k") {
    const items = getGraveyardItems(host);
    if (items.length > 1) {
      host.graveyardIndex = (host.graveyardIndex - 1 + items.length) % items.length;
      renderGraveyard(host);
    }
    return;
  }

  if (key >= "1" && key <= "9") {
    resurrectGraveyardEntry(host, parseInt(key) - 1);
    return;
  }

  if (key === "x") {
    const item = getGraveyardItems(host)[host.graveyardIndex];
    if (item?.kind === "worktree") {
      host.graveyardWorktreeDeleteConfirm = item.entry;
      renderGraveyard(host);
    }
    return;
  }

  if (key === "enter" || key === "return") {
    resurrectGraveyardEntry(host, host.graveyardIndex);
  }
}

export function resurrectGraveyardEntry(host: ArchivesHost, idx: number): void {
  const item = getGraveyardItems(host)[idx];
  if (!item) return;
  const promise =
    item.kind === "worktree"
      ? host.mode === "dashboard"
        ? postToProjectService(host, "/graveyard/worktrees/resurrect", { path: item.entry.path }, { timeoutMs: 10_000 })
        : host.resurrectGraveyardWorktree(item.entry.path)
      : host.resurrectGraveyardSession(item.entry.id);
  void promise
    .then(() => {
      host.graveyardEntries = host.listGraveyardEntries();
      host.worktreeGraveyardEntries = host.listWorktreeGraveyardEntries();
      host.graveyardWorktreeDeleteConfirm = null;
      if (getGraveyardItems(host).length === 0) {
        host.setDashboardScreen("dashboard");
        if (host.mode === "dashboard") {
          host.renderDashboard();
        } else {
          host.focusSession(host.activeIndex);
        }
        return;
      }

      clampGraveyardSelection(host);
      renderGraveyard(host);
    })
    .catch((error: unknown) => {
      debug(
        `failed to resurrect ${item.kind === "worktree" ? item.entry.path : item.entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        "session",
      );
    });
}

function getGraveyardItems(host: ArchivesHost): GraveyardItem[] {
  return [
    ...host.worktreeGraveyardEntries.map((entry: WorktreeGraveyardEntry) => ({ kind: "worktree", entry }) as const),
    ...host.graveyardEntries.map((entry: any) => ({ kind: "agent", entry }) as const),
  ];
}

function clampGraveyardSelection(host: ArchivesHost): void {
  const items = getGraveyardItems(host);
  if (host.graveyardIndex >= items.length) {
    host.graveyardIndex = Math.max(0, items.length - 1);
  }
}

async function deleteSelectedGraveyardWorktree(host: ArchivesHost): Promise<void> {
  const entry = host.graveyardWorktreeDeleteConfirm;
  if (!entry) return;
  try {
    if (host.mode === "dashboard") {
      await postToProjectService(host, "/graveyard/worktrees/delete", { path: entry.path }, { timeoutMs: 10_000 });
    } else {
      await host.deleteGraveyardWorktree(entry.path);
    }
    host.worktreeGraveyardEntries = host.listWorktreeGraveyardEntries();
    host.graveyardEntries = host.listGraveyardEntries();
    host.graveyardWorktreeDeleteConfirm = null;
    clampGraveyardSelection(host);
    if (getGraveyardItems(host).length === 0) {
      host.setDashboardScreen("dashboard");
      host.renderDashboard();
      return;
    }
    renderGraveyard(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.showDashboardError(`Failed to delete "${entry.name}"`, [message]);
  }
}

function loadGraveyardEntries(host: ArchivesHost): void {
  const graveyardPath = getGraveyardPath();
  try {
    host.graveyardEntries = JSON.parse(readFileSync(graveyardPath, "utf-8"));
  } catch {
    host.graveyardEntries = [];
  }
  host.worktreeGraveyardEntries = listWorktreeGraveyardEntries();
}

async function refreshGraveyardEntriesFromService(host: ArchivesHost): Promise<void> {
  const endpoint = resolveProjectServiceEndpoint(process.cwd());
  if (!endpoint) return;
  try {
    const { status, json } = await requestJson<{ ok?: boolean; entries?: any[]; worktrees?: WorktreeGraveyardEntry[] }>(
      `http://${endpoint.host}:${endpoint.port}/graveyard`,
      { timeoutMs: 3000 },
    );
    if (status < 200 || status >= 300 || json?.ok !== true) return;
    host.graveyardEntries = Array.isArray(json.entries) ? json.entries : [];
    host.worktreeGraveyardEntries = Array.isArray(json.worktrees) ? json.worktrees : [];
    clampGraveyardSelection(host);
    if (host.isDashboardScreen?.("graveyard")) {
      renderGraveyard(host);
    }
  } catch (error) {
    debug(
      `failed to refresh graveyard from service: ${error instanceof Error ? error.message : String(error)}`,
      "session",
    );
  }
}

export function showPlans(host: ArchivesHost): void {
  host.clearDashboardSubscreens();
  loadPlanEntries(host);
  host.setDashboardScreen("plans");
  if (host.planIndex >= host.planEntries.length) {
    host.planIndex = Math.max(0, host.planEntries.length - 1);
  }
  host.writeStatuslineFile();
  renderPlans(host);
}

export function loadPlanEntries(host: ArchivesHost): void {
  const plansDir = getPlansDir();
  const entries: any[] = [];
  try {
    mkdirSync(plansDir, { recursive: true });
    const files = readdirSync(plansDir)
      .filter((file) => file.endsWith(".md"))
      .sort();
    for (const file of files) {
      const path = join(plansDir, file);
      const content = readFileSync(path, "utf-8");
      const sessionId = file.replace(/\.md$/, "");
      const frontmatter = parsePlanFrontmatter(content);
      entries.push({
        sessionId,
        tool: frontmatter.tool,
        label: host.getSessionLabel(sessionId),
        worktree: frontmatter.worktree,
        updatedAt: frontmatter.updatedAt,
        path,
        content,
      });
    }
  } catch {}
  entries.sort((a, b) => {
    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bTime - aTime || a.sessionId.localeCompare(b.sessionId);
  });
  host.planEntries = entries;
}

export function parsePlanFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const data: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") break;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return data;
}

export function renderPlans(host: ArchivesHost): void {
  renderPlansScreen(host);
}

export function buildPlanPreview(content: string, width: number, maxLines: number): string[] {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const rawLines = body.length > 0 ? body.split(/\r?\n/) : ["(empty)"];
  const preview: string[] = [];
  for (const line of rawLines) {
    if (preview.length >= maxLines) break;
    const normalized = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
    preview.push(normalized);
  }
  return preview;
}

export function renderPlanDetailsForHost(host: ArchivesHost, width: number, height: number): string[] {
  return renderPlanDetails(host, width, height);
}

export function renderGraveyardDetailsForHost(host: ArchivesHost, width: number, height: number): string[] {
  return renderGraveyardDetails(host, width, height);
}

export function handlePlansKey(host: ArchivesHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderPlans(host);
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
  if (host.handleDashboardSubscreenNavigationKey(key, "plans")) return;

  if (key === "?") {
    host.showHelp();
    return;
  }

  if (key === "r") {
    loadPlanEntries(host);
    if (host.planIndex >= host.planEntries.length) {
      host.planIndex = Math.max(0, host.planEntries.length - 1);
    }
    renderPlans(host);
    return;
  }

  if (key === "down" || key === "j") {
    if (host.planEntries.length > 1) {
      host.planIndex = (host.planIndex + 1) % host.planEntries.length;
      renderPlans(host);
    }
    return;
  }

  if (key === "up" || key === "k") {
    if (host.planEntries.length > 1) {
      host.planIndex = (host.planIndex - 1 + host.planEntries.length) % host.planEntries.length;
      renderPlans(host);
    }
    return;
  }

  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < host.planEntries.length) {
      host.planIndex = idx;
      renderPlans(host);
    }
    return;
  }

  if (key === "e" || key === "enter" || key === "return") {
    const selectedPlan = host.planEntries[host.planIndex];
    if (!selectedPlan) return;
    openPlanInEditor(host, selectedPlan.path);
  }
}

export function openPlanInEditor(host: ArchivesHost, path: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || "vim";
  const shell = process.env.SHELL || "/bin/zsh";
  const shellEscape = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

  host.terminalHost.exitRawMode();
  host.terminalHost.exitAlternateScreen();

  const result = spawnSync(shell, ["-lc", `${editor} ${shellEscape(path)}`], { stdio: "inherit" });

  host.terminalHost.enterRawMode();
  host.terminalHost.enterAlternateScreen(true);

  if (result.error) {
    host.dashboardErrorState = {
      title: `Failed to open editor "${editor}"`,
      lines: [result.error.message],
    };
  }

  loadPlanEntries(host);
  host.planIndex = Math.min(host.planIndex, Math.max(0, host.planEntries.length - 1));
  renderPlans(host);
  if (host.dashboardErrorState) {
    host.renderDashboardErrorOverlay();
  }
}
