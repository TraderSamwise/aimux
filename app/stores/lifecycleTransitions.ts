import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type {
  ProjectLifecycleTransition,
  ProjectLifecycleTransitionOperation,
} from "../../src/project-api-contract";
import type {
  DesktopService,
  DesktopSession,
  DesktopState,
  DesktopWorktree,
} from "@/lib/desktop-state";

export interface AppLifecycleTransitionRecord {
  transition: ProjectLifecycleTransition;
  label?: string;
  tool?: string;
  worktreeName?: string;
  worktreePath?: string;
}

export interface RecordProjectLifecycleTransitionInput extends Omit<
  AppLifecycleTransitionRecord,
  "transition"
> {
  projectPath: string;
  transition?: ProjectLifecycleTransition;
}

export interface SettleProjectLifecycleTransitionsInput {
  projectPath: string;
  state: DesktopState;
}

const ACTIVE_PHASES = new Set(["queued", "started", "settling"]);

export const projectLifecycleTransitionsFamily = atomFamily((_projectPath: string) =>
  atom<AppLifecycleTransitionRecord[]>([]),
);

export const recordProjectLifecycleTransitionAtom = atom(
  null,
  (get, set, input: RecordProjectLifecycleTransitionInput) => {
    const transition = input.transition;
    if (!transition || !ACTIVE_PHASES.has(transition.phase)) return;
    const current = get(projectLifecycleTransitionsFamily(input.projectPath));
    const record: AppLifecycleTransitionRecord = {
      transition,
      label: input.label,
      tool: input.tool,
      worktreeName: input.worktreeName,
      worktreePath: input.worktreePath ?? transition.targetPath,
    };
    set(projectLifecycleTransitionsFamily(input.projectPath), [
      ...current.filter((item) => item.transition.operationId !== transition.operationId),
      record,
    ]);
  },
);

export const settleProjectLifecycleTransitionsAtom = atom(
  null,
  (get, set, { projectPath, state }: SettleProjectLifecycleTransitionsInput) => {
    const current = get(projectLifecycleTransitionsFamily(projectPath));
    const next = current.filter((record) => !isTransitionSettled(record, state));
    if (next.length !== current.length) set(projectLifecycleTransitionsFamily(projectPath), next);
  },
);

export const clearProjectLifecycleTransitionsAtom = atom(null, (_get, set, projectPath: string) => {
  set(projectLifecycleTransitionsFamily(projectPath), []);
});

export function applyProjectLifecycleTransitionsToDesktopState(
  state: DesktopState | null,
  records: AppLifecycleTransitionRecord[],
): DesktopState | null {
  if (!state || records.length === 0) return state;
  const sessions = state.sessions.map((session) => ({ ...session }));
  const services = state.services.map((service) => ({ ...service }));
  const worktrees = state.worktrees.map((worktree) => ({ ...worktree }));

  for (const record of records) {
    const { transition } = record;
    if (!ACTIVE_PHASES.has(transition.phase)) continue;
    if (transition.targetKind === "agent") {
      overlayAgentTransition(sessions, record);
    } else if (transition.targetKind === "service") {
      overlayServiceTransition(services, record);
    } else if (transition.targetKind === "worktree") {
      overlayWorktreeTransition(worktrees, record);
    }
  }

  return { ...state, sessions, services, worktrees };
}

function overlayAgentTransition(
  sessions: DesktopSession[],
  record: AppLifecycleTransitionRecord,
): void {
  const sessionId = record.transition.targetId;
  if (!sessionId) return;
  const index = sessions.findIndex((session) => session.id === sessionId);
  const pendingAction = agentPendingAction(record.transition.operation);
  if (!pendingAction) return;
  const status = agentPendingStatus();
  if (index >= 0) {
    sessions[index] = {
      ...sessions[index],
      status,
      pendingAction,
      optimistic: true,
    };
    return;
  }
  if (!shouldCreateOptimisticAgent(record.transition.operation)) return;
  sessions.push({
    id: sessionId,
    label: record.label ?? sessionId,
    command: record.tool,
    toolConfigKey: record.tool,
    worktreePath: record.worktreePath,
    status,
    pendingAction,
    optimistic: true,
  });
}

function overlayServiceTransition(
  services: DesktopService[],
  record: AppLifecycleTransitionRecord,
): void {
  const serviceId = record.transition.targetId;
  if (!serviceId) return;
  const index = services.findIndex((service) => service.id === serviceId);
  const pendingAction = servicePendingAction(record.transition.operation);
  if (!pendingAction || index < 0) return;
  services[index] = {
    ...services[index],
    status: "offline",
    pendingAction,
    optimistic: true,
  };
}

function overlayWorktreeTransition(
  worktrees: DesktopWorktree[],
  record: AppLifecycleTransitionRecord,
): void {
  const path = record.worktreePath ?? record.transition.targetPath;
  if (!path) return;
  const index = worktrees.findIndex((worktree) => worktree.path === path);
  if (record.transition.operation === "worktree.create") {
    if (index >= 0) {
      worktrees[index] = { ...worktrees[index], pending: true };
      return;
    }
    const name =
      record.worktreeName ?? record.transition.targetId ?? path.split(/[\\/]/).pop() ?? path;
    worktrees.push({ name, path, branch: name, pending: true });
    return;
  }
  if (index >= 0) {
    worktrees[index] = { ...worktrees[index], removing: true };
  }
}

function isTransitionSettled(record: AppLifecycleTransitionRecord, state: DesktopState): boolean {
  const { transition } = record;
  if (transition.targetKind === "agent") return isAgentTransitionSettled(record, state);
  if (transition.targetKind === "service") return isServiceTransitionSettled(record, state);
  if (transition.targetKind === "worktree") return isWorktreeTransitionSettled(record, state);
  return true;
}

function isAgentTransitionSettled(
  record: AppLifecycleTransitionRecord,
  state: DesktopState,
): boolean {
  const sessionId = record.transition.targetId;
  if (!sessionId) return true;
  const session = state.sessions.find((item) => item.id === sessionId);
  switch (record.transition.operation) {
    case "agent.stop":
      return session?.status === "offline" || session?.status === "exited";
    case "agent.kill":
      return !session || session.status === "offline" || session.status === "exited";
    case "agent.resume":
    case "agent.spawn":
    case "agent.fork":
    case "graveyard.agent.resurrect":
      return Boolean(session && session.status !== "offline" && session.status !== "exited");
    case "agent.rename":
      return Boolean(session && (!record.label || session.label === record.label));
    case "agent.migrate":
      return Boolean(
        session && (!record.worktreePath || session.worktreePath === record.worktreePath),
      );
    default:
      return true;
  }
}

function isServiceTransitionSettled(
  record: AppLifecycleTransitionRecord,
  state: DesktopState,
): boolean {
  const serviceId = record.transition.targetId;
  if (!serviceId) return true;
  const service = state.services.find((item) => item.id === serviceId);
  switch (record.transition.operation) {
    case "service.stop":
      return service?.status === "offline" || service?.status === "exited";
    case "service.create":
    case "service.resume":
      return Boolean(service && service.status !== "offline" && service.status !== "exited");
    case "service.remove":
      return !service || service.status === "offline" || service.status === "exited";
    default:
      return true;
  }
}

function isWorktreeTransitionSettled(
  record: AppLifecycleTransitionRecord,
  state: DesktopState,
): boolean {
  const path = record.worktreePath ?? record.transition.targetPath;
  if (!path) return true;
  const worktree = state.worktrees.find((item) => item.path === path);
  switch (record.transition.operation) {
    case "worktree.create":
    case "graveyard.worktree.resurrect":
      return Boolean(worktree && !worktree.pending);
    case "worktree.remove":
    case "worktree.graveyard":
    case "graveyard.worktree.delete":
      return !worktree;
    default:
      return true;
  }
}

function agentPendingAction(operation: ProjectLifecycleTransitionOperation): string | null {
  switch (operation) {
    case "agent.spawn":
    case "agent.resume":
    case "graveyard.agent.resurrect":
      return "starting";
    case "agent.fork":
      return "forking";
    case "agent.stop":
      return "stopping";
    case "agent.kill":
      return "graveyarding";
    case "agent.rename":
      return "renaming";
    case "agent.migrate":
      return "migrating";
    case "agent.interrupt":
      return "interrupting";
    default:
      return null;
  }
}

function servicePendingAction(operation: ProjectLifecycleTransitionOperation): string | null {
  switch (operation) {
    case "service.create":
    case "service.resume":
      return "starting";
    case "service.stop":
      return "stopping";
    case "service.remove":
      return "removing";
    default:
      return null;
  }
}

function agentPendingStatus(): DesktopSession["status"] {
  return "waiting";
}

function shouldCreateOptimisticAgent(operation: ProjectLifecycleTransitionOperation): boolean {
  return (
    operation === "agent.spawn" ||
    operation === "agent.fork" ||
    operation === "agent.resume" ||
    operation === "graveyard.agent.resurrect"
  );
}
