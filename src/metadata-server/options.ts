import type { SessionAlertDisplayContext } from "../alert-display.js";
import type { ExposePaneOutputTapLike } from "../expose-pane-output-tap.js";
import type { ExposePreviewCacheLike } from "../expose-preview-cache.js";
import type { MetadataReadAgentOutput } from "./output-previews.js";
import type { LaunchOverride } from "../shell-args.js";
import type { MessageKind } from "../threads.js";
import type { PluginRuntimePluginStatus } from "../plugin-runtime.js";
import type { ProjectEventBus } from "../project-events.js";
import type { TaskLifecycleResult } from "../orchestration-actions.js";

export interface MetadataServerOptions {
  projectRoot?: string;
  lifecycleMutationQueueLimit?: number;
  onChange?: () => void;
  events?: {
    bus?: ProjectEventBus;
  };
  diagnostics?: {
    pluginStatuses?: () => PluginRuntimePluginStatus[];
  };
  desktop?: {
    getState?: () => Record<string, unknown>;
    listWorktrees?: () => unknown[];
    getSessionDisplayContext?: (sessionId: string) => SessionAlertDisplayContext | undefined;
    refreshStatusline?: (input?: { sessionId?: string; force?: boolean }) => Promise<{ ok: true }> | { ok: true };
    createWorktree?: (input: {
      name: string;
    }) => Promise<{ path: string; status?: string }> | { path: string; status?: string };
    removeWorktree?: (input: { path: string }) => Promise<{ path: string }> | { path: string };
    graveyardWorktree?: (input: {
      path: string;
    }) => Promise<{ path: string; status: "graveyarded" }> | { path: string; status: "graveyarded" };
    listWorktreeGraveyard?: () => unknown[];
    resurrectGraveyardWorktree?: (input: {
      path: string;
    }) => Promise<{ path: string; status: "active" }> | { path: string; status: "active" };
    deleteGraveyardWorktree?: (input: {
      path: string;
    }) => Promise<{ path: string; status: "removed" }> | { path: string; status: "removed" };
    cleanupGraveyard?: (input: { dryRun?: boolean }) => Promise<unknown> | unknown;
    cleanupWorktreeCaches?: (input: { dryRun?: boolean; includeActive?: boolean }) => Promise<unknown> | unknown;
    createService?: (input: {
      command?: string;
      worktreePath?: string;
    }) => Promise<{ serviceId: string }> | { serviceId: string };
    stopService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "stopped" }> | { serviceId: string; status: "stopped" };
    resumeService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "running" }> | { serviceId: string; status: "running" };
    removeService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "removed" }> | { serviceId: string; status: "removed" };
    resumeAgent?: (input: {
      sessionId: string;
      session?: Record<string, unknown>;
    }) =>
      | Promise<{ sessionId: string; status: "running" | "offline" }>
      | { sessionId: string; status: "running" | "offline" };
    restoreAgent?: (input: {
      sessionId: string;
      session?: Record<string, unknown>;
    }) =>
      | Promise<{ sessionId: string; status: "running" | "offline" }>
      | { sessionId: string; status: "running" | "offline" };
    listGraveyard?: () => unknown[];
    resurrectGraveyard?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string; status: "offline" }>
      | {
          sessionId: string;
          status: "offline";
        };
  };
  threads?: {
    sendMessage?: (input: {
      threadId?: string;
      from?: string;
      to?: string[];
      assignee?: string;
      tool?: string;
      worktreePath?: string;
      kind?: MessageKind;
      body: string;
      title?: string;
    }) => {
      thread: unknown;
      message: unknown;
      deliveredTo?: string[];
      threadCreated?: boolean;
    };
  };
  actions?: {
    sendHandoff?: (input: {
      from?: string;
      to?: string[];
      assignee?: string;
      tool?: string;
      body: string;
      title?: string;
      worktreePath?: string;
    }) => {
      thread: unknown;
      message: unknown;
      deliveredTo?: string[];
      threadCreated?: boolean;
    };
    acceptHandoff?: (input: { threadId: string; from?: string; body?: string }) => {
      thread: unknown;
      message: unknown;
    };
    completeHandoff?: (input: { threadId: string; from?: string; body?: string }) => {
      thread: unknown;
      message: unknown;
    };
    acceptTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    blockTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    completeTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    approveReview?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    requestTaskChanges?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    reopenTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
  };
  lifecycle?: {
    spawnAgent?: (input: {
      tool: string;
      sessionId?: string;
      worktreePath?: string;
      open?: boolean;
      launchOverride?: LaunchOverride;
      overseer?: boolean;
    }) => Promise<{ sessionId: string }> | { sessionId: string };
    createTeammateAgent?: (input: {
      parentSessionId: string;
      role?: string;
      label?: string;
      tool?: string;
      sessionId?: string;
      worktreePath?: string;
      open?: boolean;
      extraArgs?: string[];
      order?: number;
    }) =>
      | Promise<{
          sessionId: string;
          parentSessionId: string;
          teamId: string;
          role?: string;
          label?: string;
          reused?: true;
        }>
      | { sessionId: string; parentSessionId: string; teamId: string; role?: string; label?: string; reused?: true };
    forkAgent?: (input: {
      sourceSessionId: string;
      tool: string;
      targetSessionId?: string;
      instruction?: string;
      worktreePath?: string;
      open?: boolean;
      launchOverride?: LaunchOverride;
    }) => Promise<{ sessionId: string; threadId: string }> | { sessionId: string; threadId: string };
    switchAgentTool?: (input: {
      sessionId: string;
      tool: string;
      instruction?: string;
      launchOverride?: LaunchOverride;
    }) =>
      | Promise<{
          sessionId: string;
          tool: string;
          status: "running";
        }>
      | {
          sessionId: string;
          tool: string;
          status: "running";
        };
    stopAgent?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string; status: "offline" }>
      | {
          sessionId: string;
          status: "offline";
        };
    interruptAgent?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string }>
      | {
          sessionId: string;
        };
    resizeAgentPane?: (input: {
      sessionId: string;
      cols: number;
      rows: number;
    }) =>
      | Promise<{ sessionId: string; cols: number; rows: number }>
      | { sessionId: string; cols: number; rows: number };
    renameAgent?: (input: { sessionId: string; label?: string }) =>
      | Promise<{ sessionId: string; label?: string }>
      | {
          sessionId: string;
          label?: string;
        };
    migrateAgent?: (input: {
      sessionId: string;
      worktreePath: string;
    }) => Promise<{ sessionId: string; worktreePath?: string }> | { sessionId: string; worktreePath?: string };
    killAgent?: (input: { sessionId: string }) =>
      | Promise<{
          sessionId: string;
          status: "graveyard";
          previousStatus: "running" | "offline";
        }>
      | {
          sessionId: string;
          status: "graveyard";
          previousStatus: "running" | "offline";
        };
    recordBackendSessionId?: (input: {
      sessionId: string;
      backendSessionId: string;
    }) => Promise<{ sessionId: string; backendSessionId: string }> | { sessionId: string; backendSessionId: string };
    sendAgentInput?: (input: {
      sessionId: string;
      text: string;
      waitForSubmit?: boolean;
      waitForActiveDraftIdle?: boolean;
    }) => Promise<{ sessionId: string; accepted: true }> | { sessionId: string; accepted: true };
    readAgentOutput?: MetadataReadAgentOutput;
  };
  exposePreviewCache?: ExposePreviewCacheLike | false;
  exposePaneOutputTap?: ExposePaneOutputTapLike | false;
  exposeHotSnapshots?: boolean;
}
