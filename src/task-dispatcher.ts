import { type Task, readAllTasks, writeTask, cleanupTasks, hasActiveTask } from "./tasks.js";
import { loadTeamConfig } from "./team.js";

interface DispatchSession {
  id: string;
  exited: boolean;
  status: string;
  write(data: string): void;
}

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
  private tickCount = 0;
  private lastCounts = { pending: 0, assigned: 0 };
  /** Per-session task info: sessionId → task description */
  private sessionTasks = new Map<string, string>();
  /** Recent events for flash notifications, drained by caller */
  private pendingEvents: TaskEvent[] = [];

  constructor(
    getSession: (id: string) => DispatchSession | undefined,
    getSessionTool: (id: string) => string | undefined,
    getSessionRole?: (id: string) => string | undefined,
  ) {
    this.getSession = getSession;
    this.getSessionTool = getSessionTool;
    this.getSessionRole = getSessionRole ?? (() => undefined);
  }

  /**
   * Main dispatch loop, called every ~2s from multiplexer footer refresh.
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
      else if (task.status === "assigned") {
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
      if (assignerSession && !assignerSession.exited && assignerSession.status === "idle") {
        this.notifyAssigner(assignerSession, task);
        this.pendingEvents.push({
          type: task.status === "done" ? "completed" : "failed",
          taskId: task.id,
          sessionId: task.assignedTo ?? "",
          description: task.description,
        });

        // Handle review workflow for completed tasks
        if (task.status === "done") {
          this.handleTaskCompletion(task);
        }
      }
    }

    // 3. Mark tasks as failed if assigned session has exited
    for (const task of tasks) {
      if (task.status !== "assigned" || !task.assignedTo) continue;

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
   * Handle review workflow when a task completes.
   * If the assigner's role has a reviewedBy config, auto-create a review task.
   * If a review task completes, route approval or create follow-up.
   */
  private handleTaskCompletion(task: Task): void {
    if (task.type === "review") {
      this.handleReviewCompletion(task);
      return;
    }

    // For regular tasks: check if the assigner's role requires review
    const assignerRole = task.assigner;
    if (!assignerRole) return;

    const config = loadTeamConfig();
    const roleConfig = config.roles[assignerRole];
    if (!roleConfig?.reviewedBy) return;

    const reviewerRole = roleConfig.reviewedBy;

    const reviewTask: Task = {
      id: `review-${task.id}-${Date.now().toString(36)}`,
      status: "pending",
      assignedBy: task.assignedTo ?? task.assignedBy,
      description: `Review: ${task.description}`,
      prompt: `Review the changes from task "${task.description}".\n\nResult: ${task.result ?? "(no result)"}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignee: reviewerRole,
      assigner: task.assignee,
      type: "review",
      reviewStatus: "pending",
      diff: task.diff,
      iteration: 1,
      reviewOf: task.id,
    };

    writeTask(reviewTask);
    this.pendingEvents.push({
      type: "review_created",
      taskId: reviewTask.id,
      sessionId: "",
      description: reviewTask.description,
    });
  }

  /**
   * Handle review task completion: approved → emit event; changes_requested → follow-up task.
   */
  private handleReviewCompletion(reviewTask: Task): void {
    if (reviewTask.type !== "review") return;

    if (reviewTask.reviewStatus === "approved") {
      this.pendingEvents.push({
        type: "review_approved",
        taskId: reviewTask.id,
        sessionId: reviewTask.assignedTo ?? "",
        description: reviewTask.description,
      });
      return;
    }

    if (reviewTask.reviewStatus === "changes_requested") {
      const iteration = (reviewTask.iteration ?? 1) + 1;

      // Cap iterations to prevent infinite loops
      if (iteration > 5) return;

      const followUp: Task = {
        id: `revision-${reviewTask.reviewOf ?? "unknown"}-${Date.now().toString(36)}`,
        status: "pending",
        assignedBy: reviewTask.assignedTo ?? reviewTask.assignedBy,
        description: `Revision ${iteration}: ${reviewTask.description.replace(/^Review: /, "")}`,
        prompt:
          `Changes requested by reviewer:\n\n${reviewTask.reviewFeedback ?? "(no feedback)"}\n\n` +
          `Original task: ${reviewTask.description}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        assignee: reviewTask.assigner ?? "coder",
        assigner: reviewTask.assignee,
        type: "task",
        iteration,
        reviewOf: reviewTask.reviewOf,
      };

      writeTask(followUp);
      this.pendingEvents.push({
        type: "changes_requested",
        taskId: followUp.id,
        sessionId: "",
        description: followUp.description,
      });
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
      if (session && !session.exited && session.status === "idle") return session;
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

  /**
   * Inject a task prompt into a session's PTY.
   */
  private inject(session: DispatchSession, task: Task): void {
    const prefix =
      task.type === "review"
        ? `[AIMUX REVIEW ${task.id} from ${task.assignedBy}]`
        : `[AIMUX TASK ${task.id} from ${task.assignedBy}]`;

    let prompt = `${prefix} ${task.description}\n\n`;

    if (task.type === "review" && task.diff) {
      prompt += `Diff to review:\n${task.diff.slice(0, 3000)}\n\n`;
    }

    prompt +=
      `Read .aimux/tasks/${task.id}.json for full details. When done, update that file: ` +
      `set status to "done" and add a "result" field.`;

    if (task.type === "review") {
      prompt += ` Also set "reviewStatus" to "approved" or "changes_requested", and optionally add "reviewFeedback".`;
    } else {
      prompt += ` If you can't complete it, set status to "failed" with an "error" field.`;
    }

    session.write(prompt + "\r");
    task.status = "assigned";
    task.assignedTo = session.id;
    writeTask(task);
    this.pendingEvents.push({
      type: "assigned",
      taskId: task.id,
      sessionId: session.id,
      description: task.description,
    });
  }

  /**
   * Notify the assigning session that a task has completed.
   */
  private notifyAssigner(session: DispatchSession, task: Task): void {
    session.write(
      `[AIMUX TASK COMPLETE ${task.id}] Agent ${task.assignedTo} finished: ${task.result ?? task.error ?? "no details"}\r`,
    );
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
