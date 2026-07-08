import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastControlContext, FastControlItem } from "../fast-control.js";
import { CORE_API_ROUTES } from "../core-command-contract.js";
import { getDaemonBaseUrl } from "../daemon-state.js";
import { requestJson, type HttpJsonResponse } from "../http-client.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { isDashboardWindowName } from "./runtime-manager.js";

/**
 * Exposé zoom ladder. `g` walks up it (worktree → project → global), clamped at
 * the top. The launch context picks the starting rung; zoom state is ephemeral.
 */
export type ExposeScope = "worktree" | "project" | "global";

const SCOPE_LADDER: ExposeScope[] = ["worktree", "project", "global"];

/** A tile's agent item; global-scope items also carry their project. */
export type ExposeScopeItem = FastControlItem & { projectRoot?: string; projectName?: string };

export type ExposeSublabel = "none" | "worktree" | "project-worktree";

export interface ExposeScopeView {
  scope: ExposeScope;
  items: ExposeScopeItem[];
  scopeLabel: string;
  sublabel: ExposeSublabel;
}

export interface ExposeConfig {
  initialScope?: ExposeScope;
}

export interface LoadExposeScopeDeps {
  daemonEndpoint?: string;
  metadataEndpoint?: string;
  requestJsonFn?: typeof requestJson;
}

interface SwitchableAgentsResponse {
  ok?: boolean;
  items?: ExposeScopeItem[];
}

interface ExposeFocusResponse {
  ok?: boolean;
}

function projectServiceEndpoint(projectStateDir: string, deps: LoadExposeScopeDeps): string {
  return deps.metadataEndpoint ?? readFileSync(join(projectStateDir, "metadata-api.txt"), "utf8").trim();
}

function appendFocusContext(url: URL, context: FastControlContext): void {
  if (context.currentClientSession) url.searchParams.set("currentClientSession", context.currentClientSession);
  if (context.currentWindow) url.searchParams.set("currentWindow", context.currentWindow);
  if (context.currentWindowId) url.searchParams.set("currentWindowId", context.currentWindowId);
  if (context.currentPath) url.searchParams.set("currentPath", context.currentPath);
}

async function requestExposeItems(url: URL, deps: LoadExposeScopeDeps): Promise<ExposeScopeItem[]> {
  const requester = deps.requestJsonFn ?? requestJson;
  const response = (await requester<SwitchableAgentsResponse>(url.toString(), {
    timeoutMs: 4000,
  })) as HttpJsonResponse<SwitchableAgentsResponse>;
  return response.json.ok === true && Array.isArray(response.json.items) ? response.json.items : [];
}

/** Next rung up the ladder; the top (global) is a no-op. */
export function nextExposeScope(scope: ExposeScope): ExposeScope {
  const i = SCOPE_LADDER.indexOf(scope);
  return SCOPE_LADDER[Math.min(i + 1, SCOPE_LADDER.length - 1)]!;
}

/** Starting rung for a freshly opened Exposé, derived from the launch context. */
export function initialExposeScope(
  crossProject: boolean,
  context: FastControlContext,
  config: ExposeConfig = {},
): ExposeScope {
  if (crossProject) return "global";
  const initialScope = config.initialScope ?? "worktree";
  if (initialScope !== "worktree") return initialScope;
  const currentWindow = context.currentWindow?.trim();
  if (!context.currentWindowId?.trim()) return "project";
  if (currentWindow && isDashboardWindowName(currentWindow)) return "project";
  return "worktree";
}

/** Resolve the tiles, label, and sublabel kind for a given rung. */
export async function loadExposeScopeItems(
  scope: ExposeScope,
  context: FastControlContext,
  projectStateDir: string,
  deps: LoadExposeScopeDeps = {},
): Promise<ExposeScopeView> {
  if (scope === "global") {
    const endpoint = deps.daemonEndpoint ?? getDaemonBaseUrl();
    const url = new URL(CORE_API_ROUTES.exposeItems, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    const items = await requestExposeItems(url, deps);
    return {
      scope,
      items,
      scopeLabel: "all projects",
      sublabel: "project-worktree",
    };
  }

  const endpoint = projectServiceEndpoint(projectStateDir, deps);
  const url = new URL(PROJECT_API_ROUTES.controls.switchableAgents, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  url.searchParams.set("scope", scope === "worktree" ? "worktree" : "all");
  url.searchParams.set("labelFormat", "raw");
  appendFocusContext(url, context);
  const items = await requestExposeItems(url, deps);
  return {
    scope,
    items,
    scopeLabel: scope === "worktree" ? "this worktree" : "all worktrees",
    sublabel: scope === "worktree" ? "none" : "worktree",
  };
}

export async function focusExposeItem(
  item: ExposeScopeItem,
  context: FastControlContext & { clientTty?: string },
  projectStateDir: string,
  deps: LoadExposeScopeDeps = {},
): Promise<boolean> {
  const endpoint = item.projectRoot
    ? (deps.daemonEndpoint ?? getDaemonBaseUrl())
    : projectServiceEndpoint(projectStateDir, deps);
  const route = item.projectRoot ? CORE_API_ROUTES.exposeFocus : PROJECT_API_ROUTES.controls.focusWindow;
  const url = new URL(route, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  const requester = deps.requestJsonFn ?? requestJson;
  const response = (await requester<ExposeFocusResponse>(url.toString(), {
    method: "POST",
    body: {
      windowId: item.target.windowId,
      projectRoot: item.projectRoot,
      currentClientSession: context.currentClientSession,
      clientTty: context.clientTty,
      focus: true,
    },
    timeoutMs: 4000,
  })) as HttpJsonResponse<ExposeFocusResponse>;
  return response.json.ok === true;
}
