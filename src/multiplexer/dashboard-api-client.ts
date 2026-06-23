import { isDashboardLifecycleCurrent, type DashboardApiViewRefreshOptions } from "./dashboard-lifecycle.js";
import { getOrCreateTuiApiRuntime } from "./tui-api-runtime.js";

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
  try {
    const refreshOptions = options.lifecycle ? { lifecycle: options.lifecycle } : undefined;
    return await host.refreshDashboardModelFromService(options.force === true, refreshOptions);
  } catch {
    return false;
  }
}
