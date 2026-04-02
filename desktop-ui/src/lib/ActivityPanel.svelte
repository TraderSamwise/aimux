<script>
  import { invoke } from "@tauri-apps/api/core";
  import { getState, trackAction } from "../stores/state.svelte.js";

  let { visible = false } = $props();

  const appState = getState();

  let loading = $state(false);
  let error = $state(null);
  let entries = $state([]);

  async function load() {
    const project = appState.selectedProject;
    if (!visible || !project) {
      entries = [];
      return;
    }
    loading = true;
    error = null;
    try {
      const result = await invoke("workflow_list", {
        projectPath: project.path,
        participant: "user",
      });
      entries = Array.isArray(result) ? result : [];
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  async function runTaskAction(kind, taskId) {
    const project = appState.selectedProject;
    if (!project || !taskId) return;
    const commandByKind = {
      accept: "task_accept",
      block: "task_block",
      complete: "task_complete",
      reopen: "task_reopen",
      approve: "review_approve",
      request_changes: "review_request_changes",
    };
    const labelByKind = {
      accept: "Accepting task...",
      block: "Blocking task...",
      complete: "Completing task...",
      reopen: "Reopening task...",
      approve: "Approving review...",
      request_changes: "Requesting changes...",
    };
    try {
      await trackAction(
        {
          kind: `workflow-${kind}`,
          message: labelByKind[kind],
          projectPath: project.path,
          taskId,
        },
        () =>
          invoke(commandByKind[kind], {
            projectPath: project.path,
            taskId,
            from: "user",
            body: null,
          }),
      );
      await load();
    } catch (err) {
      error = String(err);
    }
  }

  async function runHandoffAction(kind, threadId) {
    const project = appState.selectedProject;
    if (!project || !threadId) return;
    try {
      await trackAction(
        {
          kind: `workflow-handoff-${kind}`,
          message: kind === "accept" ? "Accepting handoff..." : "Completing handoff...",
          projectPath: project.path,
          threadId,
        },
        () =>
          invoke(kind === "accept" ? "handoff_accept" : "handoff_complete", {
            projectPath: project.path,
            threadId,
            from: "user",
            body: null,
          }),
      );
      await load();
    } catch (err) {
      error = String(err);
    }
  }

  function latestText(entry) {
    return entry?.latestMessage?.body || entry?.task?.description || null;
  }

  function actionButtons(entry) {
    const task = entry.task;
    if (!task && entry.thread.kind === "handoff") {
      return ["accept-handoff", "complete-handoff"];
    }
    if (!task) return [];
    if (task.type === "review") {
      if (task.status === "pending" || task.status === "assigned") return ["approve", "request_changes"];
      if (task.status === "done") return ["reopen"];
      return [];
    }
    if (task.status === "pending" || task.status === "assigned") return ["accept", "block"];
    if (task.status === "in_progress") return ["block", "complete"];
    if (task.status === "blocked" || task.status === "done") return ["reopen"];
    return [];
  }

  $effect(() => {
    appState.selectedProject?.path;
    appState.projects;
    if (visible) {
      void load();
    }
  });
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Activity</span>
  </div>

  <div class="panel-body">
    {#if !appState.selectedProject}
      <div class="empty">Select a project to view workflow activity.</div>
    {:else if loading && entries.length === 0}
      <div class="empty">Loading workflow…</div>
    {:else if error}
      <div class="error">{error}</div>
    {:else if entries.length === 0}
      <div class="empty">No workflow activity yet.</div>
    {:else}
      <div class="entry-list">
        {#each entries as entry (entry.thread.id)}
          <article class="entry-card">
            <div class="entry-top">
              <div>
                <div class="entry-title">{entry.displayTitle || entry.thread.title || entry.thread.id}</div>
                <div class="entry-meta">
                  <span>{entry.thread.kind}</span>
                  <span>{entry.stateLabel || entry.thread.status}</span>
                  {#if entry.task?.status}
                    <span>task: {entry.task.status}</span>
                  {/if}
                </div>
              </div>
              <div class="entry-actions">
                {#each actionButtons(entry) as action}
                  {#if action === "accept-handoff"}
                    <button class="action-btn" onclick={() => runHandoffAction("accept", entry.thread.id)}>accept</button>
                  {:else if action === "complete-handoff"}
                    <button class="action-btn" onclick={() => runHandoffAction("complete", entry.thread.id)}>complete</button>
                  {:else if action === "request_changes"}
                    <button class="action-btn" onclick={() => runTaskAction("request_changes", entry.task?.id)}>request changes</button>
                  {:else}
                    <button class="action-btn" onclick={() => runTaskAction(action, entry.task?.id)}>{action}</button>
                  {/if}
                {/each}
              </div>
            </div>
            {#if latestText(entry)}
              <div class="entry-body">{latestText(entry)}</div>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .panel-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }

  .panel-body {
    overflow: auto;
    padding: 12px 16px 16px;
  }

  .entry-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .entry-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(15, 23, 34, 0.7);
    padding: 12px;
  }

  .entry-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .entry-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .entry-meta {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .entry-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .action-btn {
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid rgba(125, 211, 252, 0.25);
    background: rgba(56, 189, 248, 0.1);
    color: var(--accent);
    font-size: 11px;
  }

  .entry-body {
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.4;
    white-space: pre-wrap;
  }

  .empty,
  .error {
    padding: 24px 4px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .error {
    color: var(--red);
  }
</style>
