import { randomUUID } from "node:crypto";

export type InteractionType = "permission" | "exit_plan" | "question" | "input";

export type InteractionStatus = "pending" | "resolved" | "timed_out" | "cancelled";

export interface PermissionPayload {
  toolName: string;
  input?: unknown;
  summary?: string;
}

export interface ExitPlanPayload {
  plan?: string;
  summary?: string;
}

export interface QuestionPayload {
  question: string;
  options?: string[];
}

export interface InputPayload {
  prompt?: string;
}

export type InteractionPayload =
  | PermissionPayload
  | ExitPlanPayload
  | QuestionPayload
  | InputPayload
  | Record<string, unknown>;

export interface InteractionResponse {
  /** Permission/plan decision, e.g. "allow_once" | "allow_always" | "deny". */
  decision?: string;
  /** Selected option(s) for a question interaction. */
  selection?: string | string[];
  /** Free-text reply for an input interaction, or feedback alongside a decision. */
  text?: string;
  reason?: string;
}

export interface InteractionRequest {
  id: string;
  sessionId: string;
  /** Optional: the registry is project-scoped, but the hook always knows it. */
  projectRoot?: string;
  type: InteractionType;
  payload: InteractionPayload;
  status: InteractionStatus;
  createdAt: string;
  resolvedAt?: string;
  response?: InteractionResponse;
}

export interface RegisterInteractionInput {
  sessionId: string;
  type: InteractionType;
  payload: InteractionPayload;
  projectRoot?: string;
  /** Caller-supplied id (e.g. an agent's request id); otherwise generated. */
  id?: string;
}

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

type Waiter = (request: InteractionRequest) => void;

/** Pure in-memory registry of pending agent interaction requests (approvals,
 * plan gates, questions, input); callers orchestrate register/alert/respond. */
export class InteractionRegistry {
  private readonly requests = new Map<string, InteractionRequest>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly settledTtlMs: number;

  constructor(options: { settledTtlMs?: number } = {}) {
    this.settledTtlMs = options.settledTtlMs ?? 5 * 60_000;
  }

  register(input: RegisterInteractionInput): InteractionRequest {
    this.pruneSettled();
    const id = input.id?.trim() || randomUUID();
    const request: InteractionRequest = {
      id,
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      type: input.type,
      payload: input.payload,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.requests.set(id, request);
    return request;
  }

  get(id: string): InteractionRequest | undefined {
    return this.requests.get(id);
  }

  listPending(sessionId?: string): InteractionRequest[] {
    const pending: InteractionRequest[] = [];
    for (const request of this.requests.values()) {
      if (request.status !== "pending") continue;
      if (sessionId && request.sessionId !== sessionId) continue;
      pending.push(request);
    }
    return pending;
  }

  resolve(id: string, response: InteractionResponse): InteractionRequest | undefined {
    return this.settle(id, "resolved", response);
  }

  cancel(id: string): InteractionRequest | undefined {
    return this.settle(id, "cancelled");
  }

  /** Cancel every pending request for a session, e.g. when the session ends. */
  cancelSession(sessionId: string): void {
    for (const request of this.requests.values()) {
      if (request.status === "pending" && request.sessionId === sessionId) {
        this.settle(request.id, "cancelled");
      }
    }
  }

  /** Settle when the request leaves pending or timeoutMs elapses (timed_out);
   * returns immediately if already settled; an aborted signal cancels it. */
  wait(id: string, options: WaitOptions): Promise<InteractionRequest> {
    const existing = this.requests.get(id);
    if (existing && existing.status !== "pending") {
      return Promise.resolve(existing);
    }
    return new Promise<InteractionRequest>((resolvePromise) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(this.settle(id, "timed_out") ?? this.requests.get(id) ?? this.makeMissing(id));
      }, options.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const waiter: Waiter = (request) => finish(request);
      const onAbort = () => finish(this.settle(id, "cancelled") ?? this.requests.get(id) ?? this.makeMissing(id));
      const finish = (request: InteractionRequest): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.removeWaiter(id, waiter);
        resolvePromise(request);
      };
      this.addWaiter(id, waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const current = this.requests.get(id);
      if (current && current.status !== "pending") finish(current);
    });
  }

  private settle(
    id: string,
    status: Exclude<InteractionStatus, "pending">,
    response?: InteractionResponse,
  ): InteractionRequest | undefined {
    const request = this.requests.get(id);
    if (!request || request.status !== "pending") return undefined;
    request.status = status;
    request.resolvedAt = new Date().toISOString();
    if (response) request.response = response;
    this.notify(id, request);
    return request;
  }

  private makeMissing(id: string): InteractionRequest {
    return {
      id,
      sessionId: "",
      type: "permission",
      payload: {},
      status: "cancelled",
      createdAt: new Date().toISOString(),
    };
  }

  private addWaiter(id: string, waiter: Waiter): void {
    const set = this.waiters.get(id) ?? new Set<Waiter>();
    set.add(waiter);
    this.waiters.set(id, set);
  }

  private removeWaiter(id: string, waiter: Waiter): void {
    const set = this.waiters.get(id);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) this.waiters.delete(id);
  }

  private notify(id: string, request: InteractionRequest): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const waiter of [...set]) {
      waiter(request);
    }
  }

  /** Drop settled requests past the TTL so the registry can't grow unbounded. */
  private pruneSettled(): void {
    const cutoff = Date.now() - this.settledTtlMs;
    for (const [id, request] of this.requests) {
      if (request.status !== "pending" && request.resolvedAt && Date.parse(request.resolvedAt) <= cutoff) {
        this.requests.delete(id);
      }
    }
  }
}

export const interactionRegistry = new InteractionRegistry();
