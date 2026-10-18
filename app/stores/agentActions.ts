import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { ProjectStateKey } from "@/lib/project-key";
import type { ProjectLifecycleTransition } from "../../src/project-api-contract";

export type AgentRowAction = "resume" | "stop" | "fork" | "overseer" | "plane" | "kill";

export interface AgentActionState {
  busyAction: AgentRowAction | null;
  error: string | null;
}

interface AgentActionScope {
  projectStateKey: ProjectStateKey;
  sessionId: string;
}

interface AgentActionInput {
  action: AgentRowAction;
  request: () => Promise<{ transition?: ProjectLifecycleTransition }>;
  onStarted?: () => void;
  onSucceeded: (response: { transition?: ProjectLifecycleTransition }) => void;
  onFailed: () => void;
}

export const agentActionsFamily = atomFamily(
  (_scope: AgentActionScope) => {
    const state = atom<AgentActionState>({ busyAction: null, error: null });
    return atom(
      (get) => get(state),
      async (get, set, input: AgentActionInput) => {
        if (get(state).busyAction !== null) return;
        set(state, { busyAction: input.action, error: null });
        try {
          input.onStarted?.();
          const response = await input.request();
          input.onSucceeded(response);
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : error == null ? "" : String(error);
          set(state, {
            busyAction: input.action,
            error: reason || "Agent action failed. Check the project and try again.",
          });
          input.onFailed();
        } finally {
          set(state, { ...get(state), busyAction: null });
        }
      },
    );
  },
  (left, right) =>
    left.projectStateKey === right.projectStateKey && left.sessionId === right.sessionId,
);
