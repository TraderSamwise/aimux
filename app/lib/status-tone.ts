// Status → Tailwind text-color class mappings, shared by the sidebar tree,
// the main panel cards, and the service detail screen.

export const AGENT_STATUS_TONE: Record<string, string> = {
  running: "text-emerald-500",
  idle: "text-zinc-400",
  waiting: "text-amber-500",
  exited: "text-zinc-500",
  offline: "text-zinc-500",
};

export const SERVICE_STATUS_TONE: Record<string, string> = {
  running: "text-emerald-500",
  exited: "text-zinc-500",
  offline: "text-zinc-500",
};

export function firstTokenOf(command: string | undefined): string {
  if (!command) return "";
  return command.split(/\s+/)[0];
}
