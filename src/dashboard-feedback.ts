export interface DashboardBusyState {
  title: string;
  lines: string[];
  startedAt: number;
  spinnerFrame: number;
}

export interface DashboardErrorState {
  title: string;
  lines: string[];
}

export class DashboardFeedbackController {
  private _busyState: DashboardBusyState | null = null;
  private busySpinner: ReturnType<typeof setInterval> | null = null;
  private _errorState: DashboardErrorState | null = null;
  private _flash: string | null = null;
  private _flashTicks = 0;

  constructor(
    private readonly callbacks: {
      renderDashboard: () => void;
      isDashboardMode: () => boolean;
    },
  ) {}

  get busyState(): DashboardBusyState | null {
    return this._busyState;
  }

  set busyState(value: DashboardBusyState | null) {
    this._busyState = value;
  }

  get errorState(): DashboardErrorState | null {
    return this._errorState;
  }

  set errorState(value: DashboardErrorState | null) {
    this._errorState = value;
  }

  get flash(): string | null {
    return this._flash;
  }

  set flash(value: string | null) {
    this._flash = value;
  }

  get flashTicks(): number {
    return this._flashTicks;
  }

  set flashTicks(value: number) {
    this._flashTicks = value;
  }

  startBusy(title: string, lines: string[]): void {
    this._errorState = null;
    this._busyState = {
      title,
      lines,
      startedAt: Date.now(),
      spinnerFrame: 0,
    };
    if (this.busySpinner) {
      clearInterval(this.busySpinner);
    }
    this.busySpinner = setInterval(() => {
      if (!this._busyState) return;
      this._busyState.spinnerFrame = (this._busyState.spinnerFrame + 1) % 10;
      if (this.callbacks.isDashboardMode()) this.callbacks.renderDashboard();
    }, 120);
    this._flash = null;
    this._flashTicks = 0;
    this.callbacks.renderDashboard();
  }

  updateBusy(lines: string[]): void {
    if (!this._busyState) return;
    this._busyState.lines = lines;
    if (this.callbacks.isDashboardMode()) this.callbacks.renderDashboard();
  }

  clearBusy(): void {
    if (this.busySpinner) {
      clearInterval(this.busySpinner);
      this.busySpinner = null;
    }
    this._busyState = null;
  }

  showError(title: string, lines: string[]): void {
    this.clearBusy();
    this._errorState = { title, lines };
    this.callbacks.renderDashboard();
  }

  dismissError(): void {
    this._errorState = null;
    this.callbacks.renderDashboard();
  }

  setFlash(message: string, ticks: number): void {
    this._flash = message;
    this._flashTicks = ticks;
  }

  tickFlashVisibilityChanged(): boolean {
    const hadFlash = this._flashTicks > 0 || this._flash !== null;
    if (this._flashTicks > 0) this._flashTicks--;
    if (this._flashTicks === 0) this._flash = null;
    const hasFlash = this._flashTicks > 0 || this._flash !== null;
    return hadFlash !== hasFlash;
  }

  async runOperation<T>(
    title: string,
    lines: string[],
    work: () => Promise<T> | T,
    errorTitle = title,
  ): Promise<T | undefined> {
    this.startBusy(title, lines);
    const minVisibleMs = 250;
    const startedAt = Date.now();
    try {
      const result = await work();
      const remaining = minVisibleMs - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      this.clearBusy();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showError(errorTitle, [message]);
      return undefined;
    }
  }
}
