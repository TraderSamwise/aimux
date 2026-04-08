import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { getGraveyardPath, getPlansDir } from "./paths.js";
import { debug } from "./debug.js";
import { parseKeys } from "./key-parser.js";
import {
  renderGraveyardDetails,
  renderGraveyardScreen,
  renderPlanDetails,
  renderPlansScreen,
} from "./tui/screens/subscreen-renderers.js";

type ArchivesHost = any;

export function showGraveyard(host: ArchivesHost): void {
  host.clearDashboardSubscreens();
  const graveyardPath = getGraveyardPath();
  try {
    host.graveyardEntries = JSON.parse(readFileSync(graveyardPath, "utf-8"));
  } catch {
    host.graveyardEntries = [];
  }
  if (host.graveyardIndex >= host.graveyardEntries.length) {
    host.graveyardIndex = Math.max(0, host.graveyardEntries.length - 1);
  }
  host.setDashboardScreen("graveyard");
  host.writeStatuslineFile();
  renderGraveyard(host);
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

  if (key === "down" || key === "j" || key === "n") {
    if (host.graveyardEntries.length > 1) {
      host.graveyardIndex = (host.graveyardIndex + 1) % host.graveyardEntries.length;
      renderGraveyard(host);
    }
    return;
  }

  if (key === "up" || key === "k") {
    if (host.graveyardEntries.length > 1) {
      host.graveyardIndex = (host.graveyardIndex - 1 + host.graveyardEntries.length) % host.graveyardEntries.length;
      renderGraveyard(host);
    }
    return;
  }

  if (key >= "1" && key <= "9") {
    resurrectGraveyardEntry(host, parseInt(key) - 1);
    return;
  }

  if (key === "enter" || key === "return") {
    resurrectGraveyardEntry(host, host.graveyardIndex);
  }
}

export function resurrectGraveyardEntry(host: ArchivesHost, idx: number): void {
  if (idx < 0 || idx >= host.graveyardEntries.length) return;
  const entry = host.graveyardEntries[idx];
  if (!entry) return;
  void host
    .resurrectGraveyardSession(entry.id)
    .then(() => {
      host.graveyardEntries = host.listGraveyardEntries();
      if (host.graveyardEntries.length === 0) {
        host.setDashboardScreen("dashboard");
        if (host.mode === "dashboard") {
          host.renderDashboard();
        } else {
          host.focusSession(host.activeIndex);
        }
        return;
      }

      if (host.graveyardIndex >= host.graveyardEntries.length) {
        host.graveyardIndex = host.graveyardEntries.length - 1;
      }
      renderGraveyard(host);
    })
    .catch((error: unknown) => {
      debug(`failed to resurrect ${entry.id}: ${error instanceof Error ? error.message : String(error)}`, "session");
    });
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

  if (key === "down" || key === "j" || key === "n") {
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
