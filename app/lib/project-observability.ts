import type { NotificationRecord, TaskSummaryResponse } from "@/lib/api";
import type { DesktopState } from "@/lib/desktop-state";

export interface ProjectObservabilitySummary {
  agents: number;
  services: number;
  worktrees: number;
  running: number;
  waiting: number;
  offline: number;
  tasks: number;
  openTasks: number;
  unreadNotifications: number;
}

export interface ProjectStoryItem {
  id: string;
  title: string;
  body?: string;
  meta: string;
  createdAt?: string;
}

export interface ProjectObservability {
  summary: ProjectObservabilitySummary;
  story: ProjectStoryItem[];
  openTasks: TaskSummaryResponse[];
  completedTasks: TaskSummaryResponse[];
  artifactHints: ProjectStoryItem[];
  verificationHints: ProjectStoryItem[];
}

function normalize(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

function isOpenTask(task: TaskSummaryResponse): boolean {
  const status = normalize(task.status);
  return !["done", "complete", "completed", "closed", "cancelled", "canceled"].includes(status);
}

function taskTitle(task: TaskSummaryResponse): string {
  return task.description || task.id;
}

function notificationMentions(haystack: string, words: string[]): boolean {
  return words.some((word) => haystack.includes(word));
}

function storyFromNotification(record: NotificationRecord): ProjectStoryItem {
  return {
    id: `notification:${record.id}`,
    title: record.title || record.subtitle || "aimux",
    body: record.body,
    meta: [record.kind?.replace(/[_-]+/g, " "), record.sessionId].filter(Boolean).join(" · "),
    createdAt: record.createdAt,
  };
}

export function buildProjectObservability(input: {
  desktopState: DesktopState | null;
  notifications: NotificationRecord[];
  tasks: TaskSummaryResponse[];
}): ProjectObservability {
  const sessions = input.desktopState?.sessions ?? [];
  const services = input.desktopState?.services ?? [];
  const worktrees = input.desktopState?.worktrees ?? [];
  const runtimeStatuses = [...sessions, ...services].map((item) => normalize(item.status));
  const openTasks = input.tasks.filter(isOpenTask);
  const completedTasks = input.tasks.filter((task) => !isOpenTask(task));

  const notificationStory = input.notifications.slice(0, 8).map(storyFromNotification);
  const taskStory = openTasks.slice(0, 6).map<ProjectStoryItem>((task) => ({
    id: `task:${task.id}`,
    title: taskTitle(task),
    body: task.status,
    meta: [task.assignedTo ?? task.assignee, task.tool, task.threadId].filter(Boolean).join(" · "),
  }));

  const artifactHints = input.notifications
    .filter((record) =>
      notificationMentions(
        normalize([record.title, record.subtitle, record.body, record.kind].join(" ")),
        ["artifact", "file", "commit", "diff", "patch", "screenshot", "proof"],
      ),
    )
    .slice(0, 8)
    .map(storyFromNotification);

  const verificationHints = input.notifications
    .filter((record) =>
      notificationMentions(
        normalize([record.title, record.subtitle, record.body, record.kind].join(" ")),
        ["test", "verify", "verification", "passed", "failed", "proof"],
      ),
    )
    .slice(0, 8)
    .map(storyFromNotification);

  return {
    summary: {
      agents: sessions.length,
      services: services.length,
      worktrees: worktrees.length,
      running: runtimeStatuses.filter((status) => status === "running").length,
      waiting: runtimeStatuses.filter((status) => status === "waiting").length,
      offline: runtimeStatuses.filter((status) => status === "offline" || status === "exited")
        .length,
      tasks: input.tasks.length,
      openTasks: openTasks.length,
      unreadNotifications: input.notifications.filter((record) => record.unread).length,
    },
    story: [...taskStory, ...notificationStory].slice(0, 12),
    openTasks,
    completedTasks,
    artifactHints,
    verificationHints,
  };
}
