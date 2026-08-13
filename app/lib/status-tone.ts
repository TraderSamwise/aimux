// TUI-aligned status palette for app surfaces. Keep semantic status decisions
// here so sidebar, Exposé, and detail views do not drift into local palettes.

export type AppStatusKind =
  | "working"
  | "ready"
  | "idle"
  | "offline"
  | "needs"
  | "error"
  | "done"
  | "blocked"
  | "service"
  | "serviceOff";

export interface AppStatusClasses {
  bg: string;
  border: string;
  cardBorder: string;
  dot: string;
  hex: string;
  ring: string;
  text: string;
}

export const APP_STATUS_CLASSES: Record<AppStatusKind, AppStatusClasses> = {
  working: {
    bg: "bg-cyan-500/10",
    border: "border-cyan-500/30",
    cardBorder: "border-cyan-500/35",
    dot: "bg-cyan-400",
    hex: "#00afd7",
    ring: "border-cyan-400",
    text: "text-cyan-300",
  },
  ready: {
    bg: "bg-sky-500/10",
    border: "border-sky-500/30",
    cardBorder: "border-sky-500/35",
    dot: "bg-sky-400",
    hex: "#5fafff",
    ring: "border-sky-400",
    text: "text-sky-300",
  },
  idle: {
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/25",
    cardBorder: "border-emerald-500/25",
    dot: "bg-emerald-300",
    hex: "#87af87",
    ring: "border-emerald-300",
    text: "text-emerald-300",
  },
  offline: {
    bg: "bg-zinc-500/10",
    border: "border-zinc-500/20",
    cardBorder: "border-[#2a2b31]",
    dot: "bg-zinc-600",
    hex: "#808080",
    ring: "border-[#6b6d75]",
    text: "text-zinc-400",
  },
  needs: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    cardBorder: "border-amber-500/35",
    dot: "bg-amber-400",
    hex: "#d7af5f",
    ring: "border-amber-400",
    text: "text-amber-300",
  },
  error: {
    bg: "bg-rose-500/10",
    border: "border-rose-500/30",
    cardBorder: "border-rose-500/35",
    dot: "bg-rose-400",
    hex: "#d78787",
    ring: "border-rose-400",
    text: "text-rose-300",
  },
  done: {
    bg: "bg-green-500/10",
    border: "border-green-500/30",
    cardBorder: "border-green-500/35",
    dot: "bg-green-400",
    hex: "#5faf5f",
    ring: "border-green-400",
    text: "text-green-300",
  },
  blocked: {
    bg: "bg-fuchsia-500/10",
    border: "border-fuchsia-500/30",
    cardBorder: "border-fuchsia-500/35",
    dot: "bg-fuchsia-400",
    hex: "#d787d7",
    ring: "border-fuchsia-400",
    text: "text-fuchsia-300",
  },
  service: {
    bg: "bg-green-500/10",
    border: "border-green-500/30",
    cardBorder: "border-green-500/35",
    dot: "bg-green-400",
    hex: "#5faf5f",
    ring: "border-green-400",
    text: "text-green-300",
  },
  serviceOff: {
    bg: "bg-zinc-500/10",
    border: "border-zinc-500/20",
    cardBorder: "border-[#2a2b31]",
    dot: "bg-zinc-600",
    hex: "#808080",
    ring: "border-[#6b6d75]",
    text: "text-zinc-400",
  },
};

const STATUS_PRIORITY: Record<AppStatusKind, number> = {
  error: 90,
  needs: 80,
  blocked: 70,
  working: 60,
  service: 55,
  ready: 50,
  done: 45,
  idle: 30,
  offline: 10,
  serviceOff: 10,
};

export function normalizeAppStatusKind(value: string | null | undefined): AppStatusKind | null {
  switch (value) {
    case "working":
    case "ready":
    case "idle":
    case "offline":
    case "needs":
    case "error":
    case "done":
    case "blocked":
    case "service":
    case "serviceOff":
      return value;
    case "running":
    case "starting":
      return "working";
    case "waiting":
    case "needs_input":
    case "needs_response":
    case "next_step":
      return "needs";
    case "exited":
    case "graveyarding":
      return "offline";
    case "interrupted":
    case "stopping":
      return "idle";
    default:
      return null;
  }
}

export function appStatusClasses(value: string | null | undefined): AppStatusClasses {
  return APP_STATUS_CLASSES[normalizeAppStatusKind(value) ?? "offline"];
}

export function agentStatusKind(session: {
  activity?: string | null;
  attention?: string | null;
  pendingAction?: string | null;
  status?: string | null;
}): AppStatusKind {
  if (session.pendingAction) return "needs";
  const attentionKind = normalizeAppStatusKind(session.attention);
  if (attentionKind) return attentionKind;
  const activityKind = normalizeAppStatusKind(session.activity);
  if (activityKind) return activityKind;
  return normalizeAppStatusKind(session.status) ?? "offline";
}

export function serviceStatusKind(service: {
  pendingAction?: string | null;
  status?: string | null;
}): AppStatusKind {
  if (service.pendingAction) return "needs";
  return service.status === "running" ? "service" : "serviceOff";
}

export function aggregateStatusKind(
  kinds: Array<AppStatusKind | null | undefined>,
): AppStatusKind | null {
  let best: AppStatusKind | null = null;
  for (const kind of kinds) {
    if (!kind) continue;
    if (!best || STATUS_PRIORITY[kind] > STATUS_PRIORITY[best]) best = kind;
  }
  return best;
}

export const AGENT_STATUS_TONE: Record<string, string> = {
  running: APP_STATUS_CLASSES.working.text,
  idle: APP_STATUS_CLASSES.idle.text,
  waiting: APP_STATUS_CLASSES.needs.text,
  exited: APP_STATUS_CLASSES.offline.text,
  offline: APP_STATUS_CLASSES.offline.text,
};

export const SERVICE_STATUS_TONE: Record<string, string> = {
  running: APP_STATUS_CLASSES.service.text,
  exited: APP_STATUS_CLASSES.serviceOff.text,
  offline: APP_STATUS_CLASSES.serviceOff.text,
};

export function firstTokenOf(command: string | undefined): string {
  if (!command) return "";
  return command.trim().split(/\s+/, 1)[0] ?? "";
}
