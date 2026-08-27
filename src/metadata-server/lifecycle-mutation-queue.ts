import { randomUUID } from "node:crypto";

import { log } from "../debug.js";
import { userFacingErrorMessage } from "../error-display.js";
import type {
  ProjectLifecycleTransition,
  ProjectLifecycleTransitionOperation,
  ProjectLifecycleTransitionPhase,
  ProjectLifecycleTransitionTargetKind,
} from "../project-api-contract.js";

export function buildLifecycleTransition(input: {
  operation: ProjectLifecycleTransitionOperation;
  targetKind: ProjectLifecycleTransitionTargetKind;
  targetId?: string;
  targetPath?: string;
  phase?: ProjectLifecycleTransitionPhase;
  error?: string;
}): ProjectLifecycleTransition {
  const now = new Date().toISOString();
  const targetKey = input.targetId ?? input.targetPath ?? "unknown";
  return {
    operationId: `${input.operation}:${targetKey}:${randomUUID()}`,
    operation: input.operation,
    targetKind: input.targetKind,
    phase: input.phase ?? "succeeded",
    startedAt: now,
    updatedAt: now,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

export function lifecycleOk<T extends object>(
  result: T,
  input: Parameters<typeof buildLifecycleTransition>[0],
): { ok: true; transition: ProjectLifecycleTransition } & T {
  return { ...result, ok: true, transition: buildLifecycleTransition(input) };
}

export type LifecycleTransitionInput = Parameters<typeof buildLifecycleTransition>[0];
export type EarlyLifecycleResult<T> =
  | { kind: "resolved"; result: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "pending" };

export type LifecycleMutationTelemetry = {
  enqueued: number;
  started: number;
  succeeded: number;
  failed: number;
  released: number;
  rejectedConflicts: number;
  rejectedQueueFull: number;
  maxQueuedCount: number;
  maxQueuedMs: number;
  maxDurationMs: number;
  lastStartedAt: string | null;
  lastSettledAt: string | null;
  lastError: string | null;
};

export class LifecycleMutationConflictError extends Error {
  readonly status = 409;

  constructor(
    readonly requested: LifecycleTransitionInput,
    readonly active: LifecycleTransitionInput,
  ) {
    const target = requested.targetId ?? requested.targetPath ?? "unknown";
    super(`lifecycle mutation already in progress for ${requested.targetKind} ${target}`);
  }
}

export class LifecycleMutationQueueFullError extends Error {
  readonly status = 429;

  constructor(
    readonly requested: LifecycleTransitionInput,
    readonly queuedCount: number,
    readonly limit: number,
  ) {
    super(`lifecycle mutation queue is full (${queuedCount}/${limit}); wait for current operations to settle`);
  }
}

function lifecycleTargetKey(input: LifecycleTransitionInput): string | undefined {
  const target =
    input.targetKind === "worktree"
      ? input.targetPath?.trim() || input.targetId?.trim()
      : input.targetId?.trim() || input.targetPath?.trim();
  return target ? `${input.targetKind}:${target}` : `${input.targetKind}:${input.operation}:__project__`;
}

export async function waitForEarlyLifecycleResult<T>(
  promise: Promise<T>,
  timeoutMs = 50,
): Promise<EarlyLifecycleResult<T>> {
  return Promise.race([
    promise.then(
      (result) => ({ kind: "resolved" as const, result }),
      (error) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "pending" }>((resolve) => {
      setTimeout(() => resolve({ kind: "pending" }), timeoutMs);
    }),
  ]);
}

export class LifecycleMutationQueue {
  private queue: Promise<void> = Promise.resolve();
  private readonly targets = new Map<string, LifecycleTransitionInput>();
  private queuedCount = 0;
  private readonly telemetry: LifecycleMutationTelemetry = {
    enqueued: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    released: 0,
    rejectedConflicts: 0,
    rejectedQueueFull: 0,
    maxQueuedCount: 0,
    maxQueuedMs: 0,
    maxDurationMs: 0,
    lastStartedAt: null,
    lastSettledAt: null,
    lastError: null,
  };

  constructor(
    private readonly options: {
      queueLimit?: number;
      projectRoot: () => string;
    },
  ) {}

  enqueue<T>(action: () => Promise<T> | T, transition?: LifecycleTransitionInput): Promise<T> {
    const targetKey = transition ? lifecycleTargetKey(transition) : undefined;
    if (targetKey && transition && this.targets.has(targetKey)) {
      this.telemetry.rejectedConflicts += 1;
      throw new LifecycleMutationConflictError(transition, this.targets.get(targetKey)!);
    }
    const queueLimit = this.options.queueLimit ?? 32;
    if (transition && this.queuedCount >= queueLimit) {
      this.telemetry.rejectedQueueFull += 1;
      throw new LifecycleMutationQueueFullError(transition, this.queuedCount, queueLimit);
    }
    if (targetKey && transition) this.targets.set(targetKey, transition);
    const queueDepthAtEnqueue = this.queuedCount;
    const queueDepthAfterEnqueue = queueDepthAtEnqueue + 1;
    this.telemetry.enqueued += 1;
    this.telemetry.maxQueuedCount = Math.max(this.telemetry.maxQueuedCount, queueDepthAfterEnqueue);
    const operationId = transition
      ? `${transition.operation}:${transition.targetId ?? transition.targetPath ?? "unknown"}:${randomUUID()}`
      : undefined;
    if (transition) {
      log.info("lifecycle mutation enqueued", "api", {
        operationId,
        operation: transition.operation,
        targetKind: transition.targetKind,
        targetId: transition.targetId,
        targetPath: transition.targetPath,
        queueDepth: queueDepthAtEnqueue,
        queueLimit,
      });
    }
    this.queuedCount += 1;
    const queuedAt = Date.now();
    const queued = this.queue
      .catch(() => undefined)
      .then(async () => {
        if (transition) {
          const queuedMs = Date.now() - queuedAt;
          this.telemetry.started += 1;
          this.telemetry.maxQueuedMs = Math.max(this.telemetry.maxQueuedMs, queuedMs);
          this.telemetry.lastStartedAt = new Date().toISOString();
          log.info("lifecycle mutation started", "api", {
            operationId,
            operation: transition.operation,
            targetKind: transition.targetKind,
            targetId: transition.targetId,
            targetPath: transition.targetPath,
            queuedMs,
            queueDepthAtStart: this.queuedCount,
          });
        }
        const startedAt = Date.now();
        try {
          const result = await action();
          const durationMs = Date.now() - startedAt;
          this.telemetry.succeeded += 1;
          this.telemetry.maxDurationMs = Math.max(this.telemetry.maxDurationMs, durationMs);
          this.telemetry.lastSettledAt = new Date().toISOString();
          this.telemetry.lastError = null;
          if (transition) {
            log.info("lifecycle mutation succeeded", "api", {
              operationId,
              operation: transition.operation,
              targetKind: transition.targetKind,
              targetId: transition.targetId,
              targetPath: transition.targetPath,
              durationMs,
            });
          }
          return result;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          this.telemetry.failed += 1;
          this.telemetry.maxDurationMs = Math.max(this.telemetry.maxDurationMs, durationMs);
          this.telemetry.lastSettledAt = new Date().toISOString();
          this.telemetry.lastError = userFacingErrorMessage(error);
          if (transition) {
            log.warn("lifecycle mutation failed", "api", {
              operationId,
              operation: transition.operation,
              targetKind: transition.targetKind,
              targetId: transition.targetId,
              targetPath: transition.targetPath,
              durationMs,
              error: userFacingErrorMessage(error),
            });
          }
          throw error;
        }
      });
    const tracked = queued.finally(() => {
      this.queuedCount = Math.max(0, this.queuedCount - 1);
      this.telemetry.released += 1;
      if (targetKey && this.targets.get(targetKey) === transition) {
        this.targets.delete(targetKey);
      }
      if (transition) {
        log.info("lifecycle mutation released", "api", {
          operationId,
          operation: transition.operation,
          targetKind: transition.targetKind,
          targetId: transition.targetId,
          targetPath: transition.targetPath,
          queueDepth: this.queuedCount,
        });
      }
    });
    this.queue = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  diagnostics() {
    const queueLimit = this.options.queueLimit ?? 32;
    const activeTargets = [...this.targets.entries()].map(([key, transition]) => ({
      key,
      operation: transition.operation,
      targetKind: transition.targetKind,
      targetId: transition.targetId,
      targetPath: transition.targetPath,
    }));
    return {
      ok: true,
      pid: process.pid,
      projectRoot: this.options.projectRoot(),
      queuedCount: this.queuedCount,
      queueLimit,
      activeTargets,
      telemetry: { ...this.telemetry },
    };
  }
}

export function notifyLifecycleSettled(
  promise: Promise<unknown>,
  notifyCurrentRouteChange: () => void,
  action: string,
): void {
  void promise.then(
    () => notifyCurrentRouteChange(),
    (error: unknown) => {
      log.warn(`${action} failed after async acceptance`, "api", {
        error: userFacingErrorMessage(error),
      });
      notifyCurrentRouteChange();
    },
  );
}
