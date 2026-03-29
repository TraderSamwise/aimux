import type { SessionStatus } from "./status-detector.js";
import type { SessionOutputPipeline } from "./session-output-pipeline.js";
import type { SessionTerminalViewport } from "./session-terminal-state.js";
import { debug } from "./debug.js";

export interface SessionTransport {
  id: string;
  command: string;
  backendSessionId?: string;
  readonly exited: boolean;
  readonly exitCode: number | undefined;
  readonly status: SessionStatus;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  getCursorPosition(): { row: number; col: number };
  getViewportFrame(): SessionTerminalViewport;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
  destroy(): void;
}

export interface SessionRuntimeHooks {
  onEvent?: (event: SessionRuntimeEvent) => void;
}

export type SessionRuntimeEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number }
  | { type: "renderRequested"; forceFooter?: boolean; delayMs?: number }
  | { type: "repaintRequested"; delayMs?: number }
  | { type: "hydrationChanged"; hydrating: boolean }
  | { type: "loadingChanged"; loading: SessionLoadingScreen | null }
  | { type: "frameReady" };

export interface SessionLoadingScreen {
  title: string;
  subtitle: string;
}

export class SessionRuntime {
  private readonly startedAt?: number;
  private focusedResizeSettleTimeout: ReturnType<typeof setTimeout> | null = null;
  private focusedWakeTimeout: ReturnType<typeof setTimeout> | null = null;
  private hydrating = false;
  private loadingKey: string | null = null;

  constructor(
    readonly transport: SessionTransport,
    pipeline: SessionOutputPipeline,
    startTime: number | undefined,
    private hooks: SessionRuntimeHooks = {},
  ) {
    this.startedAt = startTime;
    if (startTime !== undefined) {
      pipeline.trackSessionStart(transport.id, startTime);
    }
    this.loadingKey = this.getLoadingKey(this.getLoadingScreen());

    transport.onData((data) => {
      pipeline.handleOutput(
        {
          id: transport.id,
          command: transport.command,
          write: (reply) => transport.write(reply),
          getCursorPosition: () => transport.getCursorPosition(),
        },
        data,
      );
      hooks.onEvent?.({ type: "output", data });
      this.refreshLoadingState();
    });

    transport.onExit((code) => {
      pipeline.clearSession(transport.id);
      hooks.onEvent?.({ type: "exit", code });
    });
  }

  get id(): string {
    return this.transport.id;
  }

  get command(): string {
    return this.transport.command;
  }

  get backendSessionId(): string | undefined {
    return this.transport.backendSessionId;
  }

  set backendSessionId(value: string | undefined) {
    this.transport.backendSessionId = value;
  }

  get exited(): boolean {
    return this.transport.exited;
  }

  get exitCode(): number | undefined {
    return this.transport.exitCode;
  }

  get status(): SessionStatus {
    return this.transport.status;
  }

  get startTime(): number | undefined {
    return this.startedAt;
  }

  get isHydrating(): boolean {
    return this.hydrating;
  }

  write(data: string): void {
    this.transport.write(data);
  }

  resize(cols: number, rows: number): void {
    this.transport.resize(cols, rows);
  }

  getCursorPosition(): { row: number; col: number } {
    return this.transport.getCursorPosition();
  }

  getViewportFrame(): SessionTerminalViewport {
    return this.transport.getViewportFrame();
  }

  getLoadingScreen(now = Date.now()): SessionLoadingScreen | null {
    if (this.hydrating) {
      return {
        title: "Loading session state...",
        subtitle: `Reconnecting ${this.command}`,
      };
    }
    if (this.shouldRenderStartupLoading(now)) {
      return {
        title: `Starting ${this.command}...`,
        subtitle: "Waiting for the first terminal frame",
      };
    }
    return null;
  }

  shouldRenderStartupLoading(now = Date.now()): boolean {
    if (this.hydrating) return false;
    if (this.startedAt === undefined) return false;
    if (now - this.startedAt > 15_000) return false;
    const viewport = this.transport.getViewportFrame();
    return !viewport.visibleLines.some((line) => line.cells.some((cell) => cell.chars.replace(/\s+/g, "").length > 0));
  }

  handleFocusedResize(isActive: () => boolean): void {
    if (this.focusedResizeSettleTimeout) {
      clearTimeout(this.focusedResizeSettleTimeout);
    }
    this.focusedResizeSettleTimeout = setTimeout(() => {
      this.focusedResizeSettleTimeout = null;
      if (!isActive()) return;
      debug(`focused resize settled: active=${this.id}`, "focus-repaint");
      this.hooks.onEvent?.({ type: "renderRequested", forceFooter: true });
    }, 24);
  }

  handleFocusIn(cols: number, rows: number, isActive: () => boolean): void {
    if (this.command === "codex") {
      if (this.focusedWakeTimeout) {
        clearTimeout(this.focusedWakeTimeout);
      }
      this.focusedWakeTimeout = setTimeout(() => {
        this.focusedWakeTimeout = null;
        if (!isActive()) return;
        debug(`focus-wake resize nudge: active=${this.id} cols=${cols} rows=${rows}`, "focus-repaint");
        this.transport.resize(cols, rows);
      }, 32);
    }
    this.hooks.onEvent?.({ type: "renderRequested", forceFooter: true });
    this.hooks.onEvent?.({ type: "repaintRequested", delayMs: 32 });
    this.hooks.onEvent?.({ type: "repaintRequested", delayMs: 96 });
  }

  clearFocusedTimers(): void {
    if (this.focusedResizeSettleTimeout) {
      clearTimeout(this.focusedResizeSettleTimeout);
      this.focusedResizeSettleTimeout = null;
    }
    if (this.focusedWakeTimeout) {
      clearTimeout(this.focusedWakeTimeout);
      this.focusedWakeTimeout = null;
    }
  }

  setHydrating(hydrating: boolean): void {
    if (this.hydrating === hydrating) return;
    this.hydrating = hydrating;
    this.hooks.onEvent?.({ type: "hydrationChanged", hydrating });
    this.refreshLoadingState();
  }

  private refreshLoadingState(): void {
    const loading = this.getLoadingScreen();
    const nextKey = this.getLoadingKey(loading);
    if (nextKey === this.loadingKey) return;
    const previousLoading = this.loadingKey !== null;
    this.loadingKey = nextKey;
    this.hooks.onEvent?.({ type: "loadingChanged", loading });
    if (previousLoading && loading === null) {
      this.hooks.onEvent?.({ type: "frameReady" });
    }
  }

  private getLoadingKey(loading: SessionLoadingScreen | null): string | null {
    return loading ? `${loading.title}\u0000${loading.subtitle}` : null;
  }

  onExit(cb: (code: number) => void): void {
    this.transport.onExit(cb);
  }

  kill(): void {
    this.transport.kill();
  }

  destroy(): void {
    this.clearFocusedTimers();
    this.transport.destroy();
  }
}
