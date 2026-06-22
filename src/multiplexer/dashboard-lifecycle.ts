export interface DashboardLifecycleToken {
  readonly mode: "dashboard" | "other";
  readonly inputEpoch?: number;
  readonly screen?: string;
}

type DashboardLifecycleHost = any;

export function captureDashboardLifecycle(
  host: DashboardLifecycleHost,
  opts: { inputEpoch?: boolean; screen?: string } = {},
): DashboardLifecycleToken {
  return {
    mode: host.mode === undefined || host.mode === "dashboard" ? "dashboard" : "other",
    inputEpoch: opts.inputEpoch ? (host.dashboardInputEpoch ?? 0) : undefined,
    screen: opts.screen,
  };
}

export function isDashboardLifecycleCurrent(
  host: DashboardLifecycleHost,
  token: DashboardLifecycleToken | undefined,
): boolean {
  if (host.mode !== undefined && host.mode !== "dashboard") return false;
  if (token?.mode && token.mode !== "dashboard") return false;
  if (token?.inputEpoch !== undefined && (host.dashboardInputEpoch ?? 0) !== token.inputEpoch) return false;
  if (!token?.screen) return true;
  if (typeof host.isDashboardScreen === "function") return host.isDashboardScreen(token.screen);
  if (host.dashboardState?.isScreen || host.dashboardState?.screen) {
    return host.dashboardState?.isScreen?.(token.screen) === true || host.dashboardState?.screen === token.screen;
  }
  return true;
}

export function renderDashboardIfCurrent(
  host: DashboardLifecycleHost,
  token: DashboardLifecycleToken | undefined,
  render: () => void,
): void {
  if (isDashboardLifecycleCurrent(host, token)) render();
}
