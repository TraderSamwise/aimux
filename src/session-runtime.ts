import type { SessionStatus } from "./status-detector.js";

export interface SessionTransport {
  id: string;
  command: string;
  backendSessionId?: string;
  readonly exited: boolean;
  readonly exitCode: number | undefined;
  readonly status: SessionStatus;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
  destroy(): void;
}

export interface SessionRuntimeHooks {
  onEvent?: (event: SessionRuntimeEvent) => void;
}

export type SessionRuntimeEvent = { type: "output"; data: string } | { type: "exit"; code: number };

export class SessionRuntime {
  private readonly startedAt?: number;

  constructor(
    readonly transport: SessionTransport,
    startTime: number | undefined,
    private hooks: SessionRuntimeHooks = {},
  ) {
    this.startedAt = startTime;

    transport.onData((data) => {
      hooks.onEvent?.({ type: "output", data });
    });

    transport.onExit((code) => {
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

  write(data: string): void {
    this.transport.write(data);
  }

  resize(cols: number, rows: number): void {
    this.transport.resize(cols, rows);
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
