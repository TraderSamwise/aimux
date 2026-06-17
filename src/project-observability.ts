import type { NotificationRecord } from "./notifications.js";
import type { Task, TaskStatus } from "./tasks.js";

export interface ProjectSummary {
  agentsRunning: number;
  agentsWaiting: number;
  agentsOffline: number;
  services: number;
  worktrees: number;
  openTasks: number;
  doneTasks: number;
  unreadNotifications: number;
}

export interface TaskProgress {
  pending: number;
  assigned: number;
  in_progress: number;
  blocked: number;
  done: number;
  failed: number;
  total: number;
}

export type ProjectStoryKind = "task" | "review" | "notification";

export interface ProjectStoryItem {
  id: string;
  kind: ProjectStoryKind;
  title: string;
  meta: string;
  body?: string;
  createdAt: string;
  status?: string;
}

export interface ProjectObservability {
  summary: ProjectSummary;
  progress: TaskProgress;
  story: ProjectStoryItem[];
}

export interface ProjectObservabilityInput {
  sessions: Array<{ status?: string }>;
  services: unknown[];
  worktrees: unknown[];
  tasks: Task[];
  notifications: NotificationRecord[];
  storyLimit?: number;
}

const DEFAULT_STORY_LIMIT = 30;

function isOpenTask(status: TaskStatus): boolean {
  return status !== "done" && status !== "failed";
}

export function buildProjectObservability(input: ProjectObservabilityInput): ProjectObservability {
  const { sessions, services, worktrees, tasks, notifications } = input;

  const summary: ProjectSummary = {
    agentsRunning: sessions.filter((s) => s.status === "running" || s.status === "idle").length,
    agentsWaiting: sessions.filter((s) => s.status === "waiting").length,
    agentsOffline: sessions.filter((s) => s.status === "offline" || s.status === "exited").length,
    services: services.length,
    worktrees: worktrees.length,
    openTasks: tasks.filter((t) => isOpenTask(t.status)).length,
    doneTasks: tasks.filter((t) => t.status === "done").length,
    unreadNotifications: notifications.filter((n) => n.unread).length,
  };

  const progress: TaskProgress = {
    pending: tasks.filter((t) => t.status === "pending").length,
    assigned: tasks.filter((t) => t.status === "assigned").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    total: tasks.length,
  };

  const taskStory: ProjectStoryItem[] = tasks.map((task) => ({
    id: `task:${task.id}`,
    kind: task.type === "review" ? "review" : "task",
    title: task.description || task.prompt || task.id,
    meta: `${task.status}${task.assignedTo ? ` · ${task.assignedTo}` : ""}`,
    body: task.result || task.error || task.prompt,
    createdAt: task.updatedAt || task.createdAt,
    status: task.status,
  }));

  const notificationStory: ProjectStoryItem[] = notifications.map((notification) => ({
    id: `notif:${notification.id}`,
    kind: "notification",
    title: notification.title,
    meta: `${notification.kind ?? "note"}${notification.sessionId ? ` · ${notification.sessionId}` : ""}`,
    body: notification.body,
    createdAt: notification.createdAt,
    status: notification.unread ? "unread" : "read",
  }));

  const story = [...taskStory, ...notificationStory]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, input.storyLimit ?? DEFAULT_STORY_LIMIT);

  return { summary, progress, story };
}
