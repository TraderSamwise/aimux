import { sendDirectMessage, sendThreadMessage } from "../orchestration.js";
import { sendHandoff } from "../orchestration-actions.js";
import { resolveOrchestrationRecipients } from "../orchestration-routing.js";
import type { DashboardSession } from "../dashboard/index.js";
import type { AgentCollaborationContext } from "../collaboration.js";
import type { MessageKind } from "../threads.js";
import { disabledRuntimeCore } from "../runtime-core/index.js";
import { stopProjectServices as stopProjectServicesImpl } from "./dashboard-model.js";
import {
  applyDashboardSessionLabel as applyDashboardSessionLabelImpl,
  applySessionLabel as applySessionLabelImpl,
  deriveHeadline as deriveHeadlineImpl,
  getSessionLabel as getSessionLabelImpl,
  normalizeAgentInput as normalizeAgentInputImpl,
  paneStillContainsAgentDraft as paneStillContainsAgentDraftImpl,
  readAgentHistory as readAgentHistoryImpl,
  readAgentOutput as readAgentOutputImpl,
  readStatusHeadline as readStatusHeadlineImpl,
  resolveRunningSession as resolveRunningSessionImpl,
  scheduleTmuxAgentSubmit as scheduleTmuxAgentSubmitImpl,
  updateSessionLabel as updateSessionLabelImpl,
  writeTmuxAgentInput as writeTmuxAgentInputImpl,
} from "./session-runtime-core.js";

export const agentIoMethods = {
  orchestrationWorkflowPressure(this: any, sessionId: string, status?: DashboardSession["status"]): number {
    const semantic = this.deriveSessionSemanticState(sessionId, status);
    return (
      semantic.waitingOnMeCount * 5 +
      semantic.blockedCount * 6 +
      semantic.pendingDeliveryCount * 3 +
      semantic.notifications.unreadCount * 2 +
      semantic.waitingOnThemCount
    );
  },

  deliverOrchestrationMessage(
    this: any,
    recipients: string[],
    threadId: string,
    from: string,
    body: string,
    kind: MessageKind,
    title?: string,
    messageId?: string,
  ): string[] {
    void recipients;
    void threadId;
    void from;
    void body;
    void kind;
    void title;
    void messageId;
    return [];
  },

  sendOrchestrationMessage(
    this: any,
    input: any,
  ): { thread: unknown; message: unknown; deliveredTo: string[]; threadCreated: boolean } {
    const from = input.from?.trim() || "user";
    const kind = input.kind ?? "request";
    const resolvedRecipients =
      input.threadId && !input.to?.length
        ? undefined
        : resolveOrchestrationRecipients({
            candidates: this.sessions.map((session: any) => {
              const semantic = this.deriveSessionSemanticState(session.id, session.status);
              return {
                id: session.id,
                tool: this.sessionToolKeys.get(session.id),
                role: this.sessionRoles.get(session.id),
                worktreePath: this.sessionWorktreePaths.get(session.id),
                status: semantic.user.label,
                canReceiveInput: semantic.runtime.canReceiveInput,
                isAlive: semantic.runtime.isAlive,
                workflowPressure: this.orchestrationWorkflowPressure(session.id, session.status),
                exited: session.exited,
              };
            }),
            to: input.to,
            assignee: input.assignee,
            tool: input.tool,
            worktreePath: input.worktreePath,
          });
    const result = input.threadId
      ? sendThreadMessage({
          threadId: input.threadId,
          from,
          to: resolvedRecipients,
          kind,
          body: input.body,
        })
      : sendDirectMessage({
          from,
          to: resolvedRecipients ?? [],
          kind: kind as any,
          body: input.body,
          title: input.title,
          worktreePath: input.worktreePath,
        });
    const deliveredTo = this.deliverOrchestrationMessage(
      result.message.to ?? [],
      result.thread.id,
      from,
      input.body,
      kind,
      result.thread.title,
      result.message.id,
    );
    this.writeStatuslineFile();
    if (this.mode === "dashboard") {
      this.renderCurrentDashboardView();
    }
    return {
      thread: result.thread,
      message: result.message,
      deliveredTo,
      threadCreated: result.threadCreated,
    };
  },

  sendHandoffMessage(
    this: any,
    input: any,
  ): { thread: unknown; message: unknown; deliveredTo: string[]; threadCreated: boolean } {
    const from = input.from?.trim() || "user";
    const resolvedRecipients = resolveOrchestrationRecipients({
      candidates: this.sessions.map((session: any) => {
        const semantic = this.deriveSessionSemanticState(session.id, session.status);
        return {
          id: session.id,
          tool: this.sessionToolKeys.get(session.id),
          role: this.sessionRoles.get(session.id),
          worktreePath: this.sessionWorktreePaths.get(session.id),
          status: semantic.user.label,
          canReceiveInput: semantic.runtime.canReceiveInput,
          isAlive: semantic.runtime.isAlive,
          workflowPressure: this.orchestrationWorkflowPressure(session.id, session.status),
          exited: session.exited,
        };
      }),
      to: input.to,
      assignee: input.assignee,
      tool: input.tool,
      worktreePath: input.worktreePath,
    });
    const result = sendHandoff({
      from,
      to: resolvedRecipients,
      body: input.body,
      title: input.title,
      worktreePath: input.worktreePath,
    });
    const deliveredTo = this.deliverOrchestrationMessage(
      result.message.to ?? [],
      result.thread.id,
      from,
      input.body,
      "handoff",
      result.thread.title,
      result.message.id,
    );
    this.writeStatuslineFile();
    if (this.mode === "dashboard") {
      this.renderCurrentDashboardView();
    }
    return {
      thread: result.thread,
      message: result.message,
      deliveredTo,
      threadCreated: result.threadCreated,
    };
  },

  async stopProjectServices(this: any): Promise<void> {
    await stopProjectServicesImpl(this);
  },

  getSessionLabel(this: any, sessionId: string): string | undefined {
    return getSessionLabelImpl(this, sessionId);
  },

  applySessionLabel(this: any, sessionId: string, label?: string): void {
    applySessionLabelImpl(this, sessionId, label);
  },

  applyDashboardSessionLabel(this: any, sessionId: string, label?: string): void {
    applyDashboardSessionLabelImpl(this, sessionId, label);
  },

  async updateSessionLabel(this: any, sessionId: string, label?: string): Promise<void> {
    await updateSessionLabelImpl(this, sessionId, label);
  },

  readStatusHeadline(this: any, sessionId: string): string | undefined {
    return readStatusHeadlineImpl(this, sessionId);
  },

  deriveHeadline(this: any, sessionId: string): string | undefined {
    return deriveHeadlineImpl(this, sessionId);
  },

  resolveRunningSession(this: any, sessionId: string): any {
    return resolveRunningSessionImpl(this, sessionId);
  },

  writeTmuxAgentInput(this: any, sessionId: string, transport: any, data: string): void {
    writeTmuxAgentInputImpl(this, sessionId, transport, data);
  },

  normalizeAgentInput(this: any, data: string, submit: boolean, sessionId?: string): string {
    return normalizeAgentInputImpl(this, data, submit, sessionId);
  },

  paneStillContainsAgentDraft(this: any, target: any, draft: string): boolean {
    return paneStillContainsAgentDraftImpl(this, target, draft);
  },

  scheduleTmuxAgentSubmit(this: any, sessionId: string, target: any, draft: string): void {
    scheduleTmuxAgentSubmitImpl(this, sessionId, target, draft);
  },

  async writeAgentInput(
    this: any,
    sessionId: string,
    data = "",
    parts?: any[],
    clientMessageId?: string,
    submit = false,
    collaboration?: AgentCollaborationContext,
  ): Promise<{ sessionId: string }> {
    return disabledRuntimeCore.writeAgentInput({ sessionId, data, parts, clientMessageId, submit, collaboration });
  },

  async readAgentHistory(this: any, sessionId: string, lastN?: number): Promise<any> {
    return readAgentHistoryImpl(this, sessionId, lastN);
  },

  async interruptAgent(this: any, sessionId: string): Promise<{ sessionId: string }> {
    return disabledRuntimeCore.interruptAgent({ sessionId });
  },

  async readAgentOutput(this: any, sessionId: string, startLine?: number): Promise<any> {
    return readAgentOutputImpl(this, sessionId, startLine);
  },
};

export type AgentIoMethods = typeof agentIoMethods;
