import type { DesktopSession } from "@/lib/desktop-state";

export function canResumeSession(
  session: Pick<DesktopSession, "status" | "restoreState">,
): boolean {
  if (session.status !== "offline" && session.status !== "exited") return false;
  return session.restoreState !== "blocked";
}
