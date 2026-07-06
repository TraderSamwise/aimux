import { isDashboardLifecycleCurrent, type DashboardApiViewRefreshOptions } from "./dashboard-lifecycle.js";
import { postToProjectService as postToProjectServiceTransport } from "./dashboard-control.js";
import {
  getOrCreateTuiApiRuntime,
  hasTuiApiRuntimeReadTransport,
  isTuiApiConnectionMutationBlocked,
  type TuiApiConnectionSnapshot,
  type TuiApiRequestOptions,
} from "./tui-api-runtime.js";

type DashboardApiHost = any;
interface DashboardModelApiRefreshOptions extends DashboardApiViewRefreshOptions {
  allowInactive?: boolean;
}

export type DashboardModelRefreshStatus = "applied" | "stale" | "skipped" | "failed";

export interface DashboardModelRefreshOutcome {
  ok: boolean;
  status: DashboardModelRefreshStatus;
  stale: boolean;
  connection: TuiApiConnectionSnapshot;
  error?: unknown;
}

interface DashboardApiResourceRefreshConfig<T> {
  resource: string;
  path: string;
  validate: (value: unknown) => T;
  timeoutMs?: number;
  apply: (value: T) => void;
  ensure: () => void;
}

export function isDashboardApiLifecycleCurrent(
  host: DashboardApiHost,
  options: DashboardApiViewRefreshOptions,
): boolean {
  return !options.lifecycle || isDashboardLifecycleCurrent(host, options.lifecycle);
}

export function isDashboardApiRenderLifecycleCurrent(
  host: DashboardApiHost,
  options: DashboardApiViewRefreshOptions,
): boolean {
  const lifecycle = options.renderLifecycle ?? options.lifecycle;
  return !lifecycle || isDashboardLifecycleCurrent(host, lifecycle);
}

export function getDashboardApiConnectionSnapshot(host: DashboardApiHost): TuiApiConnectionSnapshot {
  return getOrCreateTuiApiRuntime(host).getConnectionSnapshot();
}

export function isDashboardApiMutationBlocked(host: DashboardApiHost): boolean {
  return isTuiApiConnectionMutationBlocked(getDashboardApiConnectionSnapshot(host));
}

export function isDashboardModelRefreshUsable(outcome: DashboardModelRefreshOutcome): boolean {
  return outcome.ok || outcome.stale;
}

function dashboardModelRefreshOutcome(
  host: DashboardApiHost,
  status: DashboardModelRefreshStatus,
  error?: unknown,
): DashboardModelRefreshOutcome {
  const runtime = getOrCreateTuiApiRuntime(host);
  const desktopSnapshot = runtime.getSnapshot("desktop-state");
  return {
    ok: status === "applied",
    status,
    stale: desktopSnapshot.stale && desktopSnapshot.value !== undefined,
    connection: runtime.getConnectionSnapshot(),
    error,
  };
}

export async function refreshDashboardApiResource<T>(
  host: DashboardApiHost,
  config: DashboardApiResourceRefreshConfig<T>,
  options: DashboardApiViewRefreshOptions = {},
): Promise<boolean> {
  if (!isDashboardApiLifecycleCurrent(host, options)) return false;
  if (!hasTuiApiRuntimeReadTransport(host)) {
    config.ensure();
    return false;
  }
  try {
    const result = await getOrCreateTuiApiRuntime(host).refreshJson(config.resource, config.path, config.validate, {
      timeoutMs: config.timeoutMs,
      supersede: options.force,
    });
    if (!isDashboardApiLifecycleCurrent(host, options)) return false;
    if (!result.ok || !result.value) {
      config.ensure();
      return false;
    }
    config.apply(result.value);
    return true;
  } catch {
    if (isDashboardApiLifecycleCurrent(host, options)) config.ensure();
    return false;
  }
}

export async function refreshDashboardModelThroughApi(
  host: DashboardApiHost,
  options: DashboardModelApiRefreshOptions = {},
): Promise<DashboardModelRefreshOutcome> {
  if (!options.allowInactive && !isDashboardApiLifecycleCurrent(host, options)) {
    return dashboardModelRefreshOutcome(host, "skipped");
  }
  if (typeof host.refreshDashboardModelFromService !== "function") {
    return dashboardModelRefreshOutcome(host, "failed", new Error("dashboard model service refresh unavailable"));
  }
  const beforeRefresh = host.dashboardModelServiceRefreshedAt ?? 0;
  try {
    const refreshOptions =
      options.allowInactive === true
        ? { allowInactive: true }
        : options.lifecycle
          ? { lifecycle: options.lifecycle }
          : undefined;
    const result = await host.refreshDashboardModelFromService(options.force === true, refreshOptions);
    if (!options.allowInactive && !isDashboardApiLifecycleCurrent(host, options)) {
      return dashboardModelRefreshOutcome(host, "skipped");
    }
    if (host.dashboardModelServiceRefreshError) {
      return dashboardModelRefreshOutcome(host, "stale", host.dashboardModelServiceRefreshError);
    }
    if (result !== false || (host.dashboardModelServiceRefreshedAt ?? 0) > beforeRefresh) {
      return dashboardModelRefreshOutcome(host, "applied");
    }
    return dashboardModelRefreshOutcome(host, "skipped");
  } catch (error) {
    return dashboardModelRefreshOutcome(host, "failed", error);
  }
}

export async function mutateDashboardApi<T = any>(
  host: DashboardApiHost,
  path: string,
  body: unknown,
  opts: TuiApiRequestOptions | undefined = undefined,
  validate: (value: unknown) => T = (value) => value as T,
): Promise<T> {
  const mutate =
    typeof host.postToProjectService === "function"
      ? (requestPath: string, requestBody: unknown, requestOpts?: TuiApiRequestOptions) =>
          requestOpts === undefined
            ? host.postToProjectService(requestPath, requestBody)
            : host.postToProjectService(requestPath, requestBody, requestOpts)
      : (requestPath: string, requestBody: unknown, requestOpts?: TuiApiRequestOptions) =>
          requestOpts === undefined
            ? postToProjectServiceTransport(host, requestPath, requestBody)
            : postToProjectServiceTransport(host, requestPath, requestBody, requestOpts);
  const result = await getOrCreateTuiApiRuntime(host).mutateJson(path, body, validate, opts, mutate);
  if (!result.ok) throw result.error instanceof Error ? result.error : new Error(String(result.error));
  return result.value as T;
}
