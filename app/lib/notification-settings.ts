export type NotificationChannel = "browser" | "push";

export type AgentNotificationKind = "needs_input" | "blocked" | "error" | "completed" | "activity";

export interface NotificationChannelSettings {
  browser: boolean;
  push: boolean;
}

export interface AgentNotificationCategorySettings {
  enabled: boolean;
  needsInput: boolean;
  blocked: boolean;
  errors: boolean;
  completed: boolean;
  activity: boolean;
}

export interface SystemNotificationCategorySettings {
  enabled: boolean;
  relayStatus: boolean;
  projectHealth: boolean;
}

export interface NotificationCategorySettings {
  agent: AgentNotificationCategorySettings;
  system: SystemNotificationCategorySettings;
}

export interface NotificationSettings {
  enabled: boolean;
  channels: NotificationChannelSettings;
  categories: NotificationCategorySettings;
}

export const defaultNotificationSettings: NotificationSettings = Object.freeze({
  enabled: false,
  channels: {
    browser: true,
    push: false,
  },
  categories: {
    agent: {
      enabled: true,
      needsInput: true,
      blocked: true,
      errors: true,
      completed: false,
      activity: false,
    },
    system: {
      enabled: false,
      relayStatus: false,
      projectHealth: false,
    },
  },
});

export function normalizeNotificationSettings(
  input: Partial<NotificationSettings> | undefined,
): NotificationSettings {
  const defaults = defaultNotificationSettings;
  return {
    enabled: input?.enabled ?? defaults.enabled,
    channels: {
      browser: input?.channels?.browser ?? defaults.channels.browser,
      push: input?.channels?.push ?? defaults.channels.push,
    },
    categories: {
      agent: {
        enabled: input?.categories?.agent?.enabled ?? defaults.categories.agent.enabled,
        needsInput: input?.categories?.agent?.needsInput ?? defaults.categories.agent.needsInput,
        blocked: input?.categories?.agent?.blocked ?? defaults.categories.agent.blocked,
        errors: input?.categories?.agent?.errors ?? defaults.categories.agent.errors,
        completed: input?.categories?.agent?.completed ?? defaults.categories.agent.completed,
        activity: input?.categories?.agent?.activity ?? defaults.categories.agent.activity,
      },
      system: {
        enabled: input?.categories?.system?.enabled ?? defaults.categories.system.enabled,
        relayStatus:
          input?.categories?.system?.relayStatus ?? defaults.categories.system.relayStatus,
        projectHealth:
          input?.categories?.system?.projectHealth ?? defaults.categories.system.projectHealth,
      },
    },
  };
}

export function isAgentNotificationEnabled(
  settings: NotificationSettings,
  kind: AgentNotificationKind,
): boolean {
  if (!settings.enabled || !settings.categories.agent.enabled) return false;
  switch (kind) {
    case "needs_input":
      return settings.categories.agent.needsInput;
    case "blocked":
      return settings.categories.agent.blocked;
    case "error":
      return settings.categories.agent.errors;
    case "completed":
      return settings.categories.agent.completed;
    case "activity":
      return settings.categories.agent.activity;
  }
}
