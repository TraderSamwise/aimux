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
      const result = await invoke("graveyard_list", { projectPath: project.path });
      entries = Array.isArray(result) ? result : [];
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  async function resurrect(entry) {
    const project = appState.selectedProject;
    if (!project) return;
    try {
      await trackAction(
        {
          kind: "resurrect",
          message: `Resurrecting ${entry.label || entry.tool || entry.id}...`,
          projectPath: project.path,
          sessionId: entry.id,
          label: entry.label,
          role: entry.role,
          tool: entry.tool,
          worktreePath: entry.worktreePath || null,
          reconcile: () => ({ sessionId: entry.id }),
        },
        () => invoke("graveyard_resurrect", { projectPath: project.path, sessionId: entry.id }),
      );
      await load();
    } catch (err) {
      error = String(err);
    }
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
    <span class="section-label">Graveyard</span>
  </div>

  <div class="panel-body">
    {#if !appState.selectedProject}
      <div class="empty">Select a project to view the graveyard.</div>
    {:else if loading && entries.length === 0}
      <div class="empty">Loading graveyard…</div>
    {:else if error}
      <div class="error">{error}</div>
    {:else if entries.length === 0}
      <div class="empty">No graveyarded agents.</div>
    {:else}
      <div class="entry-list">
        {#each entries as entry (entry.id)}
          <article class="entry-card">
            <div class="entry-top">
              <div class="entry-title">{entry.label || entry.tool || entry.id}</div>
              <button class="resurrect-btn" onclick={() => resurrect(entry)}>resurrect</button>
            </div>
            <div class="entry-meta">
              <span>{entry.tool}</span>
              {#if entry.role}
                <span>{entry.role}</span>
              {/if}
              {#if entry.worktreePath}
                <span>{entry.worktreePath.split("/").pop()}</span>
              {/if}
            </div>
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
    align-items: center;
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

  .resurrect-btn {
    padding: 4px 8px;
    border-radius: 5px;
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(125, 211, 252, 0.2);
    color: var(--accent);
    font-size: 11px;
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
