import { loadConfig } from "./config.js";
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
  readonly kind: "pty" | "tmux";
  spawn(request: RuntimeBackendSpawnRequest): RuntimeBackendSession;
}

export class PtyRuntimeBackend implements RuntimeBackend {
  readonly kind = "pty" as const;

  spawn(request: RuntimeBackendSpawnRequest): RuntimeBackendSession {
    return new PtySession(request);
  }
}

export class TmuxRuntimeBackend implements RuntimeBackend {
  readonly kind = "tmux" as const;

  spawn(_request: RuntimeBackendSpawnRequest): RuntimeBackendSession {
    throw new Error("tmux runtime backend is not wired into the session server yet");
  }
}

export function createRuntimeBackend(): RuntimeBackend {
  const backend = loadConfig().runtime.backend;
  if (backend === "tmux") {
    // The normal tmux-backed runtime path no longer uses AimuxServer. The CLI
    // blocks `aimux server` in tmux mode, so if this helper is reached anyway,
    // keep the legacy server path usable instead of constructing a backend that
    // immediately throws on spawn.
    return new PtyRuntimeBackend();
  }
  return new PtyRuntimeBackend();
}
