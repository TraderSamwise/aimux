import { PtySession, type PtySessionOptions } from "./pty-session.js";

export interface RuntimeBackendSession {
  id: string;
  command: string;
  backendSessionId?: string;
  readonly exited: boolean;
  readonly status: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  destroy(): void;
  getTerminalSnapshot(): Promise<unknown>;
}

export type RuntimeBackendSpawnRequest = PtySessionOptions;

export interface RuntimeBackend {
  readonly kind: "pty";
  spawn(request: RuntimeBackendSpawnRequest): RuntimeBackendSession;
}

export class PtyRuntimeBackend implements RuntimeBackend {
  readonly kind = "pty" as const;

  spawn(request: RuntimeBackendSpawnRequest): RuntimeBackendSession {
    return new PtySession(request);
  }
}

export function createRuntimeBackend(): RuntimeBackend {
  return new PtyRuntimeBackend();
}
