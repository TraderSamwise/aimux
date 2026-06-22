export type TuiApiConnectionState = "connected" | "degraded" | "reconnecting" | "disposed";

export interface TuiApiRequestOptions {
  timeoutMs?: number;
}

export interface TuiApiRuntimeOptions {
  request: (path: string, opts?: TuiApiRequestOptions) => Promise<unknown>;
  onConnectionStateChange?: (state: TuiApiConnectionState) => void;
}

export interface TuiApiRefreshOptions extends TuiApiRequestOptions {
  supersede?: boolean;
}

export interface TuiApiResourceSnapshot<T = unknown> {
  value?: T;
  error?: unknown;
  generation: number;
  pending: boolean;
  stale: boolean;
  updatedAt: number;
}

export interface TuiApiRefreshResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
  stale: boolean;
  generation: number;
}

interface ResourceState<T = unknown> extends TuiApiResourceSnapshot<T> {
  pendingPromise?: Promise<TuiApiRefreshResult<T>>;
}

export class TuiApiRuntime {
  private readonly resources = new Map<string, ResourceState>();
  private state: TuiApiConnectionState = "connected";
  private disposed = false;

  constructor(private readonly options: TuiApiRuntimeOptions) {}

  getConnectionState(): TuiApiConnectionState {
    return this.state;
  }

  getSnapshot<T>(resource: string): TuiApiResourceSnapshot<T> {
    const state = this.getResource<T>(resource);
    return {
      value: state.value,
      error: state.error,
      generation: state.generation,
      pending: state.pending,
      stale: state.stale,
      updatedAt: state.updatedAt,
    };
  }

  async refreshJson<T>(
    resource: string,
    path: string,
    validate: (value: unknown) => T,
    opts: TuiApiRefreshOptions = {},
  ): Promise<TuiApiRefreshResult<T>> {
    return this.refresh(resource, async () => validate(await this.options.request(path, opts)), opts);
  }

  async refresh<T>(
    resource: string,
    load: () => Promise<T>,
    opts: TuiApiRefreshOptions = {},
  ): Promise<TuiApiRefreshResult<T>> {
    if (this.disposed) {
      return { ok: false, error: new Error("TUI API runtime disposed"), stale: true, generation: 0 };
    }
    const state = this.getResource<T>(resource);
    if (state.pendingPromise && !opts.supersede) return state.pendingPromise;

    const generation = state.generation + 1;
    state.generation = generation;
    state.pending = true;
    state.stale = state.value !== undefined;
    state.error = undefined;

    const promise = load()
      .then((value) => {
        if (this.disposed || state.generation !== generation) {
          return { ok: false, value: state.value, stale: true, generation };
        }
        state.value = value;
        state.error = undefined;
        state.pending = false;
        state.stale = false;
        state.updatedAt = Date.now();
        state.pendingPromise = undefined;
        this.setConnectionState("connected");
        return { ok: true, value, stale: false, generation };
      })
      .catch((error: unknown) => {
        if (!this.disposed && state.generation === generation) {
          state.error = error;
          state.pending = false;
          state.stale = state.value !== undefined;
          state.pendingPromise = undefined;
          this.setConnectionState(state.value === undefined ? "reconnecting" : "degraded");
        }
        return { ok: false, value: state.value, error, stale: state.value !== undefined, generation };
      });

    state.pendingPromise = promise;
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.setConnectionState("disposed");
    for (const state of this.resources.values()) {
      state.pending = false;
      state.pendingPromise = undefined;
    }
  }

  private getResource<T>(resource: string): ResourceState<T> {
    let state = this.resources.get(resource) as ResourceState<T> | undefined;
    if (!state) {
      state = {
        generation: 0,
        pending: false,
        stale: false,
        updatedAt: 0,
      };
      this.resources.set(resource, state);
    }
    return state;
  }

  private setConnectionState(next: TuiApiConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onConnectionStateChange?.(next);
  }
}

export function getOrCreateTuiApiRuntime(host: any): TuiApiRuntime {
  if (host.tuiApiRuntime instanceof TuiApiRuntime) return host.tuiApiRuntime;
  host.tuiApiRuntime = new TuiApiRuntime({
    request: (path, opts) => host.getFromProjectService(path, opts),
    onConnectionStateChange: (state) => {
      host.tuiApiConnectionState = state;
    },
  });
  return host.tuiApiRuntime;
}
