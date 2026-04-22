import { type Task, readAllTasks, writeTask, cleanupTasks, hasActiveTask } from "./tasks.js";
import { loadTeamConfig } from "./team.js";
import { TaskWorkflow } from "./task-workflow.js";
import type { SessionAvailability } from "./session-semantics.js";

interface DispatchSession {
  id: string;
  exited: boolean;
  status: string;
  write(data: string): void;
}

type PromptDelivery = (session: Pick<DispatchSession, "id" | "write">, prompt: string) => void;

export interface TaskEvent {
  type: "assigned" | "completed" | "failed" | "review_created" | "review_approved" | "changes_requested";
  taskId: string;
  sessionId: string;
  description: string;
}

export class TaskDispatcher {
  private getSession: (id: string) => DispatchSession | undefined;
  private getSessionTool: (id: string) => string | undefined;
  private getSessionRole: (id: string) => string | undefined;
  private getSessionAvailability: (id: string) => SessionAvailability;
  private tickCount = 0;
  private lastCounts = { pending: 0, assigned: 0 };
  private workflow: TaskWorkflow;
  /** Per-session task info: sessionId → task description */
  private sessionTasks = new Map<string, string>();
  /** Recent events for flash notifications, drained by caller */
  private pendingEvents: TaskEvent[] = [];

  constructor(
    getSession: (id: string) => DispatchSession | undefined,
    getSessionTool: (id: string) => string | undefined,
    getSessionRole: (id: string) => string | undefined,
    getSessionAvailability: (id: string) => SessionAvailability,
    deliverPrompt?: PromptDelivery,
  ) {
    this.getSession = getSession;
    this.getSessionTool = getSessionTool;
    this.getSessionRole = getSessionRole;
    this.getSessionAvailability = getSessionAvailability;
    this.workflow = new TaskWorkflow(deliverPrompt);
  }

  /**
   * Main dispatch loop, called every ~2s from the dashboard/status refresh loop.
   */
  tick(localSessionIds: string[]): void {
    this.tickCount++;
    const tasks = readAllTasks();

    // Update cached counts + per-session task map
    let pending = 0;
    let assigned = 0;
    this.sessionTasks.clear();
    for (const task of tasks) {
      if (task.status === "pending") pending++;
      else if (task.status === "assigned" || task.status === "in_progress" || task.status === "blocked") {
        assigned++;
        if (task.assignedTo) {
          this.sessionTasks.set(task.assignedTo, task.description);
        }
      }
    }
    this.lastCounts = { pending, assigned };

    // 1. Dispatch pending tasks to idle local sessions
    for (const task of tasks) {
      if (task.status !== "pending") continue;

      const targetSession = this.findIdleSession(task, localSessionIds);
      if (targetSession) {
        this.inject(targetSession, task);
      }
    }

    // 2. Notify assigners of completed tasks + handle review routing
    for (const task of tasks) {
      if ((task.status !== "done" && task.status !== "failed") || task.notifiedAt) continue;

      const assignerSession = this.getSession(task.assignedBy);
      if (assignerSession && this.canReceiveInjectedPrompt(assignerSession)) {
        this.workflow.notifyAssigner(assignerSession, task);
        this.pendingEvents.push({
          type: task.status === "done" ? "completed" : "failed",
          taskId: task.id,
          sessionId: task.assignedTo ?? "",
          description: task.description,
        });

        // Handle review workflow for completed tasks
        if (task.status === "done") {
          this.pendingEvents.push(...this.workflow.handleCompletion(task));
        }
      }
    }

    // 3. Mark tasks as failed if assigned session has exited
    for (const task of tasks) {
      if (
        (task.status !== "assigned" && task.status !== "in_progress" && task.status !== "blocked") ||
        !task.assignedTo
      )
        continue;

      if (!localSessionIds.includes(task.assignedTo)) continue;
      const session = this.getSession(task.assignedTo);
      if (session && session.exited) {
        task.status = "failed";
        task.error = "agent exited before completing task";
        writeTask(task);
      }
    }

    // 4. Periodic cleanup (~every 200s)
    if (this.tickCount % 100 === 0) {
      cleanupTasks(3600000);
    }
  }

  /**
   * Find an idle local session matching the task's targeting criteria.
   * Priority: assignedTo (specific session) > assignee (role) > tool > any idle.
   */
  private findIdleSession(task: Task, localSessionIds: string[]): DispatchSession | undefined {
    const isEligible = (id: string): DispatchSession | undefined => {
      if (id === task.assignedBy) return undefined; // don't delegate to self
      if (hasActiveTask(id)) return undefined; // already working a task
      const session = this.getSession(id);
      if (session && this.canReceiveInjectedPrompt(session)) {
        return session;
      }
      return undefined;
    };

    // Check assignedTo first (specific session targeting)
    if (task.assignedTo) {
      if (!localSessionIds.includes(task.assignedTo)) return undefined;
      return isEligible(task.assignedTo);
    }

    // Match by role name
    if (task.assignee) {
      for (const id of localSessionIds) {
        if (this.getSessionRole(id) !== task.assignee) continue;
        const session = isEligible(id);
        if (session) return session;
      }
    }

    // Match by tool type
    if (task.tool) {
      for (const id of localSessionIds) {
        if (this.getSessionTool(id) !== task.tool) continue;
        const session = isEligible(id);
        if (session) return session;
      }
    }

    // Any idle session (only if no targeting specified)
    if (!task.tool && !task.assignee) {
      for (const id of localSessionIds) {
        const session = isEligible(id);
        if (session) return session;
      }
    }

    return undefined;
  }

  private canReceiveInjectedPrompt(session: DispatchSession): boolean {
    if (session.exited) return false;
    const availability = this.getSessionAvailability(session.id);
    return availability === "available" || availability === "needs_input";
  }

  private inject(session: DispatchSession, task: Task): void {
    this.pendingEvents.push(this.workflow.injectIntoSession(session, task));
  }

  /**
   * Notify the assigning session that a task has completed.
   */
  private notifyAssigner(session: DispatchSession, task: Task): void {
    this.workflow.notifyAssigner(session, task);
    task.notifiedAt = new Date().toISOString();
    writeTask(task);
  }

  /**
   * Get cached counts from last tick.
   */
  getTaskCounts(): { pending: number; assigned: number } {
    return this.lastCounts;
  }

  /**
   * Get the task description assigned to a session, if any.
   */
  getSessionTask(sessionId: string): string | undefined {
    return this.sessionTasks.get(sessionId);
  }

  /**
   * Drain pending events (for flash notifications). Returns and clears the queue.
   */
  drainEvents(): TaskEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }
}

/**
 * Create a review task for the active session's recent work.
 * Called from the [v] hotkey handler.
 */
export function requestReview(
  agentSessionId: string,
  agentRole: string,
  diff: string | undefined,
  summary: string,
): Task | null {
  const config = loadTeamConfig();
  const roleConfig = config.roles[agentRole];
  let reviewerRole = roleConfig?.reviewedBy;

  if (!reviewerRole) {
    // No reviewer configured — try to find any reviewer role
    const fallback = Object.entries(config.roles).find(
      ([_, rc]) => rc.canEdit || rc.description.toLowerCase().includes("review"),
    );
    if (!fallback) return null;
    reviewerRole = fallback[0];
  }

  const reviewTask: Task = {
    id: `review-manual-${Date.now().toString(36)}`,
    status: "pending",
    assignedBy: agentSessionId,
    description: `Review: ${summary.slice(0, 100)}`,
    prompt: summary,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignee: reviewerRole,
    assigner: agentRole,
    type: "review",
    reviewStatus: "pending",
    diff,
    iteration: 1,
  };

  writeTask(reviewTask);
  return reviewTask;
}
