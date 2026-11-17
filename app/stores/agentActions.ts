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
  /**
   * Return a string to say something went wrong alongside a success.
   *
   * A kill can succeed and still fail to move the dead manager's reports up,
   * and the response says so. Without somewhere to put that, the user saw a
   * clean kill while the role registry still had the reports bound to an agent
   * in the graveyard.
   */
  onSucceeded: (response: { transition?: ProjectLifecycleTransition }) => string | void;
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
          const note = input.onSucceeded(response);
          if (note) {
            set(state, { busyAction: input.action, error: note });
          }
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
