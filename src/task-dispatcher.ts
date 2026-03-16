import { type Task, readAllTasks, writeTask, cleanupTasks, hasActiveTask } from "./tasks.js";
import type { PtySession } from "./pty-session.js";

export class TaskDispatcher {
  private getSession: (id: string) => PtySession | undefined;
  private getSessionTool: (id: string) => string | undefined;
  private cwd?: string;
  private tickCount = 0;
  private lastCounts = { pending: 0, assigned: 0 };

  constructor(
    getSession: (id: string) => PtySession | undefined,
    getSessionTool: (id: string) => string | undefined,
    cwd?: string,
  ) {
    this.getSession = getSession;
    this.getSessionTool = getSessionTool;
    this.cwd = cwd;
  }

  /**
   * Main dispatch loop, called every ~2s from multiplexer footer refresh.
   */
  tick(localSessionIds: string[]): void {
    this.tickCount++;
    const tasks = readAllTasks(this.cwd);

    // Update cached counts
    let pending = 0;
    let assigned = 0;
    for (const task of tasks) {
      if (task.status === "pending") pending++;
      else if (task.status === "assigned") assigned++;
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

    // 2. Notify assigners of completed tasks
    for (const task of tasks) {
      if ((task.status !== "done" && task.status !== "failed") || task.notifiedAt) continue;

      const assignerSession = this.getSession(task.assignedBy);
      if (assignerSession && !assignerSession.exited && assignerSession.status === "idle") {
        this.notifyAssigner(assignerSession, task);
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
        writeTask(task, this.cwd);
      }
    }

    // 4. Periodic cleanup (~every 200s)
    if (this.tickCount % 100 === 0) {
      cleanupTasks(3600000, this.cwd);
    }
  }

  /**
   * Find an idle local session matching the task's targeting criteria.
   */
  private findIdleSession(task: Task, localSessionIds: string[]): PtySession | undefined {
    const isEligible = (id: string): PtySession | undefined => {
      if (id === task.assignedBy) return undefined; // don't delegate to self
      if (hasActiveTask(id, this.cwd)) return undefined; // already working a task
      const session = this.getSession(id);
      if (session && !session.exited && session.status === "idle") return session;
      return undefined;
    };

    // Check assignedTo first
    if (task.assignedTo) {
      if (!localSessionIds.includes(task.assignedTo)) return undefined;
      return isEligible(task.assignedTo);
    }

    // Match by tool type
    if (task.tool) {
      for (const id of localSessionIds) {
        if (this.getSessionTool(id) !== task.tool) continue;
        const session = isEligible(id);
        if (session) return session;
      }
    }

    // Any idle session
    if (!task.tool) {
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
  private inject(session: PtySession, task: Task): void {
    session.write(
      `[AIMUX TASK ${task.id} from ${task.assignedBy}] ${task.description}\n\n` +
        `Read .aimux/tasks/${task.id}.json for full details. When done, update that file: ` +
        `set status to "done" and add a "result" field. If you can't complete it, set status to "failed" with an "error" field.\r`,
    );
    task.status = "assigned";
    task.assignedTo = session.id;
    writeTask(task, this.cwd);
  }

  /**
   * Notify the assigning session that a task has completed.
   */
  private notifyAssigner(session: PtySession, task: Task): void {
    session.write(
      `[AIMUX TASK COMPLETE ${task.id}] Agent ${task.assignedTo} finished: ${task.result ?? task.error ?? "no details"}\r`,
    );
    task.notifiedAt = new Date().toISOString();
    writeTask(task, this.cwd);
  }

  /**
   * Get cached counts from last tick.
   */
  getTaskCounts(): { pending: number; assigned: number } {
    return this.lastCounts;
  }
}
