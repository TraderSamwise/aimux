export type TuiApiConnectionState =
  | "ready"
  | "refreshing"
  | "stale"
  | "reconnecting"
  | "repairing"
  | "repaired"
  | "failed"
  | "disposed";

export interface TuiApiRequestOptions {
  timeoutMs?: number;
  recoverOnFailure?: boolean;
}

export interface TuiApiRuntimeOptions {
  request: TuiApiRequestTransport;
  mutate?: TuiApiMutationTransport;
  criticalResources?: readonly string[];
  onConnectionStateChange?: (state: TuiApiConnectionState) => void;
  onRequestFailure?: (error: unknown) => void;
  shouldRecoverFromError?: (error: unknown) => boolean;
}

interface TuiApiRecoveryOptions {
  immediate?: boolean;
}

type TuiApiRequestTransport = (path: string, opts?: TuiApiRequestOptions) => Promise<unknown>;
type TuiApiMutationTransport = (path: string, body: unknown, opts?: TuiApiRequestOptions) => Promise<unknown>;

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

export interface TuiApiConnectionSnapshot {
  state: TuiApiConnectionState;
  updatedAt: number;
  pendingResources: string[];
  staleResources: string[];
  failedResources: string[];
  failedCriticalResources: string[];
  lastError?: unknown;
}

export interface TuiApiRefreshResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
  stale: boolean;
  generation: number;
}

export interface TuiApiMutationResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

interface ResourceState<T = unknown> extends TuiApiResourceSnapshot<T> {
  lastRefresh?: {
    load: () => Promise<T>;
    opts: TuiApiRefreshOptions;
  };
  pendingPromise?: Promise<TuiApiRefreshResult<T>>;
}

export const TUI_API_RECOVERY_DEBOUNCE_MS = 250;
export const TUI_API_RECOVERY_COOLDOWN_MS = 1000;

export class TuiApiRuntime {
  private readonly resources = new Map<string, ResourceState>();
  private readonly criticalResources: ReadonlySet<string>;
  private state: TuiApiConnectionState = "ready";
  private stateUpdatedAt = Date.now();
  private lastError: unknown;
  private disposed = false;
  private requestGeneration = 0;
  private lastSuccessfulRequestGeneration = 0;

  constructor(private readonly options: TuiApiRuntimeOptions) {
    this.criticalResources = new Set(options.criticalResources ?? []);
  }

  getConnectionState(): TuiApiConnectionState {
    return this.state;
  }

  getConnectionSnapshot(): TuiApiConnectionSnapshot {
    const pendingResources: string[] = [];
    const staleResources: string[] = [];
    const failedResources: string[] = [];
    const failedCriticalResources: string[] = [];
    for (const [resource, state] of this.resources) {
      if (state.pending) pendingResources.push(resource);
      if (state.stale) staleResources.push(resource);
      if (state.error !== undefined) {
        failedResources.push(resource);
        if (this.criticalResources.has(resource)) failedCriticalResources.push(resource);
      }
    }
    return {
      state: this.state,
      updatedAt: this.stateUpdatedAt,
      pendingResources,
      staleResources,
      failedResources,
      failedCriticalResources,
      lastError: this.lastError,
    };
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
    request: TuiApiRequestTransport = this.options.request,
  ): Promise<TuiApiRefreshResult<T>> {
    const { timeoutMs } = opts;
    const requestOpts = timeoutMs === undefined ? undefined : { timeoutMs };
    return this.refresh(resource, async () => validate(await request(path, requestOpts)), opts);
  }

  async requestJson<T>(
    path: string,
    validate: (value: unknown) => T,
    opts: TuiApiRequestOptions = {},
    request: TuiApiRequestTransport = this.options.request,
  ): Promise<TuiApiMutationResult<T>> {
    if (this.disposed) {
      return { ok: false, error: new Error("TUI API runtime disposed") };
    }
    const requestOpts = opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs };
    const generation = ++this.requestGeneration;
    try {
      const value = validate(await request(path, requestOpts));
      if (this.disposed) {
        return { ok: false, error: new Error("TUI API runtime disposed") };
      }
      this.markRequestSuccess(generation);
      return { ok: true, value };
    } catch (error) {
      if (this.disposed) {
        return { ok: false, error: new Error("TUI API runtime disposed") };
      }
      if (this.shouldRecoverFromRequestFailure(error, generation, opts)) {
        this.markRecoverableFailure(error);
        this.options.onRequestFailure?.(error);
      }
      return { ok: false, error };
    }
  }

  async mutateJson<T>(
    path: string,
    body: unknown,
    validate: (value: unknown) => T,
    opts: TuiApiRequestOptions = {},
    mutate: TuiApiMutationTransport | undefined = this.options.mutate,
  ): Promise<TuiApiMutationResult<T>> {
    if (this.disposed) {
      return { ok: false, error: new Error("TUI API runtime disposed") };
    }
    if (!mutate) {
      return { ok: false, error: new Error("TUI API mutation transport unavailable") };
    }
    const requestOpts = opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs };
    const generation = ++this.requestGeneration;
    try {
      const value = validate(await mutate(path, body, requestOpts));
      if (this.disposed) {
        return { ok: false, error: new Error("TUI API runtime disposed") };
      }
      this.markRequestSuccess(generation);
      return { ok: true, value };
    } catch (error) {
      if (this.disposed) {
        return { ok: false, error: new Error("TUI API runtime disposed") };
      }
      if (this.shouldRecoverFromRequestFailure(error, generation, opts)) {
        this.markRecoverableFailure(error);
        this.options.onRequestFailure?.(error);
      }
      return { ok: false, error };
    }
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
    state.lastRefresh = { load, opts };
    state.generation = generation;
    state.pending = true;
    state.stale = state.value !== undefined;
    this.markResourceRefreshStarted();
    const requestGeneration = ++this.requestGeneration;

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
        this.markRequestSuccess(requestGeneration);
        return { ok: true, value, stale: false, generation };
      })
      .catch((error: unknown) => {
        if (this.disposed || state.generation !== generation) {
          return { ok: false, value: state.value, stale: true, generation };
        }
        if (!this.disposed && state.generation === generation) {
          state.error = error;
          state.pending = false;
          state.stale = state.value !== undefined;
          state.pendingPromise = undefined;
          if (this.shouldRecoverFromResourceFailure(resource, error, requestGeneration, opts)) {
            this.markRecoverableFailure(error);
            this.options.onRequestFailure?.(error);
          }
        }
        return { ok: false, value: state.value, error, stale: state.value !== undefined, generation };
      });

    state.pendingPromise = promise;
    return promise;
  }

  async refreshCriticalResources(): Promise<void> {
    if (this.disposed) return;
    const refreshes: Promise<TuiApiRefreshResult<unknown>>[] = [];
    for (const resource of this.criticalResources) {
      const state = this.resources.get(resource);
      if (!state?.lastRefresh || state.error === undefined) continue;
      refreshes.push(this.refresh(resource, state.lastRefresh.load, { ...state.lastRefresh.opts, supersede: true }));
    }
    await Promise.allSettled(refreshes);
  }

  beginRecovery(): void {
    if (this.disposed) return;
    this.setConnectionState("repairing");
  }

  markRecoveryFailed(error: unknown): void {
    if (this.disposed) return;
    this.lastError = error;
    this.setConnectionState("failed");
  }

  finishRecovery(): void {
    if (this.disposed) return;
    if (this.hasCriticalResourceFailure()) {
      this.setConnectionState(this.hasAnyStaleResource() ? "stale" : "reconnecting");
      return;
    }
    this.lastError = undefined;
    this.setConnectionState("repaired");
    this.setConnectionState("ready");
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
    this.stateUpdatedAt = Date.now();
    this.options.onConnectionStateChange?.(next);
  }

  private markRequestSuccess(generation: number): void {
    this.lastSuccessfulRequestGeneration = Math.max(this.lastSuccessfulRequestGeneration, generation);
    if (!this.hasCriticalResourceFailure()) {
      this.lastError = undefined;
      this.setConnectionState("ready");
    }
  }

  private markResourceRefreshStarted(): void {
    if (this.hasCriticalResourceFailure() || this.state === "repairing") return;
    this.setConnectionState("refreshing");
  }

  private markRecoverableFailure(error: unknown): void {
    this.lastError = error;
    this.setConnectionState(this.hasAnyStaleResource() ? "stale" : "reconnecting");
  }

  private hasCriticalResourceFailure(): boolean {
    for (const resource of this.criticalResources) {
      const state = this.resources.get(resource);
      if (state?.error !== undefined) return true;
    }
    return false;
  }

  private hasAnyStaleResource(): boolean {
    for (const state of this.resources.values()) {
      if (state.stale) return true;
    }
    return false;
  }

  private shouldRecoverFromError(error: unknown): boolean {
    return this.options.shouldRecoverFromError?.(error) ?? isRecoverableTuiApiError(error);
  }

  private shouldRecoverFromRequestFailure(error: unknown, generation: number, opts: TuiApiRequestOptions): boolean {
    if (opts.recoverOnFailure === false) return false;
    return this.lastSuccessfulRequestGeneration <= generation && this.shouldRecoverFromError(error);
  }

  private shouldRecoverFromResourceFailure(
    resource: string,
    error: unknown,
    generation: number,
    opts: TuiApiRequestOptions,
  ): boolean {
    if (opts.recoverOnFailure === false) return false;
    if (this.criticalResources.has(resource)) return this.shouldRecoverFromError(error);
    return this.lastSuccessfulRequestGeneration <= generation && this.shouldRecoverFromError(error);
  }
}

export function isRecoverableTuiApiError(error: unknown): boolean {
  const recoverable = (error as { tuiApiRecoverable?: unknown })?.tuiApiRecoverable;
  if (recoverable === true) return true;
  if (recoverable === false) return false;
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") {
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400 && status < 500) return false;
  }
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") return true;
  return true;
}

export function getOrCreateTuiApiRuntime(host: any): TuiApiRuntime {
  if (host.tuiApiRuntime instanceof TuiApiRuntime) {
    return host.tuiApiRuntime;
  }
  host.tuiApiRuntime = new TuiApiRuntime({
    request: (path, opts) =>
      opts === undefined ? host.getFromProjectService(path) : host.getFromProjectService(path, opts),
    mutate: (path, body, opts) =>
      opts === undefined ? host.postToProjectService(path, body) : host.postToProjectService(path, body, opts),
    criticalResources: ["desktop-state"],
    onConnectionStateChange: (state) => {
      host.tuiApiConnectionState = state;
      host.tuiApiConnectionSnapshot = host.tuiApiRuntime?.getConnectionSnapshot?.();
    },
    onRequestFailure: () => {
      scheduleTuiApiRecovery(host);
    },
  });
  return host.tuiApiRuntime;
}

function tuiApiRecoveryDelay(host: any, immediate: boolean): number {
  if (typeof host.tuiApiLastRecoveryAt !== "number") {
    return immediate ? 0 : TUI_API_RECOVERY_DEBOUNCE_MS;
  }
  const sinceLast = Date.now() - host.tuiApiLastRecoveryAt;
  const cooldownDelay = Math.max(0, TUI_API_RECOVERY_COOLDOWN_MS - sinceLast);
  return Math.max(immediate ? 0 : TUI_API_RECOVERY_DEBOUNCE_MS, cooldownDelay);
}

async function runScheduledTuiApiRecovery(host: any): Promise<void> {
  if (host.mode && host.mode !== "dashboard") {
    host.tuiApiRecoveryPending = false;
    return;
  }
  if (host.tuiApiRecoveryInFlight) {
    host.tuiApiRecoveryPending = true;
    return;
  }
  if (host.runtimeGuardProbing) {
    host.tuiApiRecoveryPending = true;
    scheduleTuiApiRecovery(host);
    return;
  }
  host.tuiApiRecoveryPending = false;
  host.tuiApiRecoveryInFlight = true;
  host.tuiApiRuntime?.beginRecovery?.();
  try {
    const result = host.refreshRuntimeGuard?.();
    if (result && typeof result.then === "function") await result;
    const refreshResult = host.tuiApiRuntime?.refreshCriticalResources?.();
    if (refreshResult && typeof refreshResult.then === "function") await refreshResult;
    host.tuiApiRuntime?.finishRecovery?.();
  } catch (error) {
    host.tuiApiRecoveryLastError = error;
    host.tuiApiRecoveryPending = true;
    host.tuiApiRuntime?.markRecoveryFailed?.(error);
  } finally {
    host.tuiApiRecoveryInFlight = false;
    host.tuiApiLastRecoveryAt = Date.now();
    if (host.tuiApiRecoveryPending) scheduleTuiApiRecovery(host);
  }
}

export function scheduleTuiApiRecovery(host: any, opts: TuiApiRecoveryOptions = {}): void {
  if (host.mode && host.mode !== "dashboard") return;
  host.tuiApiRecoveryPending = true;
  if (host.tuiApiRecoveryInFlight) return;
  const delay = tuiApiRecoveryDelay(host, opts.immediate === true);
  const dueAt = Date.now() + delay;
  if (host.tuiApiRecoveryTimer) {
    if ((host.tuiApiRecoveryDueAt ?? Number.POSITIVE_INFINITY) <= dueAt) return;
    clearTimeout(host.tuiApiRecoveryTimer);
  }
  host.tuiApiRecoveryDueAt = dueAt;
  host.tuiApiRecoveryTimer = setTimeout(() => {
    host.tuiApiRecoveryTimer = null;
    host.tuiApiRecoveryDueAt = undefined;
    void runScheduledTuiApiRecovery(host).catch(() => undefined);
  }, delay);
  host.tuiApiRecoveryTimer.unref?.();
}

export async function postJsonWithTuiApiRuntime(
  host: any,
  path: string,
  body: unknown,
  opts: TuiApiRequestOptions | undefined,
  mutate: (host: any, path: string, body: unknown, opts?: TuiApiRequestOptions) => Promise<unknown>,
): Promise<any> {
  const result = await getOrCreateTuiApiRuntime(host).mutateJson(
    path,
    body,
    (value) => value,
    opts,
    (requestPath, requestBody, requestOpts) => mutate(host, requestPath, requestBody, requestOpts),
  );
  if (!result.ok) throw result.error instanceof Error ? result.error : new Error(String(result.error));
  return result.value;
}

export async function getJsonWithTuiApiRuntime(
  host: any,
  path: string,
  opts: TuiApiRequestOptions | undefined,
  request: (host: any, path: string, opts?: TuiApiRequestOptions) => Promise<unknown>,
): Promise<any> {
  const result = await getOrCreateTuiApiRuntime(host).requestJson(
    path,
    (value) => value,
    opts,
    (requestPath, requestOpts) => request(host, requestPath, requestOpts),
  );
  if (!result.ok) throw result.error instanceof Error ? result.error : new Error(String(result.error));
  return result.value;
}
