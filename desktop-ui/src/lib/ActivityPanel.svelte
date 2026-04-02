<script>
  import { invoke } from "@tauri-apps/api/core";
  import { getState } from "../stores/state.svelte.js";

  let { visible = false } = $props();

  const state = getState();

  let loading = $state(false);
  let error = $state(null);
  let entries = $state([]);

  async function load() {
    const project = state.selectedProject;
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

  $effect(() => {
    state.selectedProject?.path;
    state.projects;
    if (visible) {
      void load();
    }
  });

  function latestText(entry) {
    return entry?.latestMessage?.body || entry?.task?.description || null;
  }
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Activity</span>
  </div>

  <div class="panel-body">
    {#if !state.selectedProject}
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
              <div class="entry-title">{entry.displayTitle || entry.thread.title || entry.thread.id}</div>
              <div class="entry-state">{entry.stateLabel || entry.thread.status}</div>
            </div>
            <div class="entry-meta">
              <span>{entry.thread.kind}</span>
              {#if entry.thread.owner}
                <span>owner: {entry.thread.owner}</span>
              {/if}
              {#if (entry.thread.waitingOn || []).length > 0}
                <span>waiting: {entry.thread.waitingOn.join(", ")}</span>
              {/if}
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
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .entry-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .entry-state {
    font-size: 11px;
    color: var(--accent);
    text-transform: lowercase;
  }

  .entry-meta {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-dim);
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
