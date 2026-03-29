import type { SessionStatus } from "./status-detector.js";
import type { SessionOutputPipeline } from "./session-output-pipeline.js";
import type { SessionTerminalViewport } from "./session-terminal-state.js";

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
  onOutput?: (data: string) => void;
  onExit?: (code: number) => void;
}

export class SessionRuntime {
  constructor(
    readonly transport: SessionTransport,
    pipeline: SessionOutputPipeline,
    startTime: number | undefined,
    hooks: SessionRuntimeHooks = {},
  ) {
    if (startTime !== undefined) {
      pipeline.trackSessionStart(transport.id, startTime);
    }

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
      hooks.onOutput?.(data);
    });

    transport.onExit((code) => {
      pipeline.clearSession(transport.id);
      hooks.onExit?.(code);
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

  onExit(cb: (code: number) => void): void {
    this.transport.onExit(cb);
  }

  kill(): void {
    this.transport.kill();
  }

  destroy(): void {
    this.transport.destroy();
  }
}
