import { isDashboardLifecycleCurrent, type DashboardApiViewRefreshOptions } from "./dashboard-lifecycle.js";
import { getOrCreateTuiApiRuntime, type TuiApiRequestOptions } from "./tui-api-runtime.js";

type DashboardApiHost = any;

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

export async function refreshDashboardApiResource<T>(
  host: DashboardApiHost,
  config: DashboardApiResourceRefreshConfig<T>,
  options: DashboardApiViewRefreshOptions = {},
): Promise<boolean> {
  if (!isDashboardApiLifecycleCurrent(host, options)) return false;
  if (typeof host.getFromProjectService !== "function") {
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
  options: DashboardApiViewRefreshOptions = {},
): Promise<boolean> {
  if (!isDashboardApiLifecycleCurrent(host, options)) return false;
  if (typeof host.refreshDashboardModelFromService !== "function") return false;
  const beforeRefresh = host.dashboardModelServiceRefreshedAt ?? 0;
  try {
    const refreshOptions = options.lifecycle ? { lifecycle: options.lifecycle } : undefined;
    const result = await host.refreshDashboardModelFromService(options.force === true, refreshOptions);
    if (!isDashboardApiLifecycleCurrent(host, options)) return false;
    if (host.dashboardModelServiceRefreshError) return false;
    return result !== false || (host.dashboardModelServiceRefreshedAt ?? 0) > beforeRefresh;
  } catch {
    return false;
  }
}

export async function mutateDashboardApi<T = any>(
  host: DashboardApiHost,
  path: string,
  body: unknown,
  opts: TuiApiRequestOptions | undefined = undefined,
  validate: (value: unknown) => T = (value) => value as T,
): Promise<T> {
  const result = await getOrCreateTuiApiRuntime(host).mutateJson(path, body, validate, opts);
  if (!result.ok) throw result.error instanceof Error ? result.error : new Error(String(result.error));
  return result.value as T;
}
