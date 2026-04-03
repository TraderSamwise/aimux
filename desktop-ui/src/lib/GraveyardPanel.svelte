<script>
  import { invoke } from "@tauri-apps/api/core";
  import { getState, trackAction } from "../stores/state.svelte.js";

  let { visible = false } = $props();

  const appState = getState();

  let loading = $state(false);
  let error = $state(null);
  let entries = $state([]);
  let selectedEntryId = $state(null);

  let selectedEntry = $derived.by(() => entries.find((entry) => entry.id === selectedEntryId) || null);

  async function load() {
    const project = appState.selectedProject;
    if (!visible || !project) {
      entries = [];
      selectedEntryId = null;
      return;
    }
    loading = true;
    error = null;
    try {
      const result = await invoke("graveyard_list", { projectPath: project.path });
      entries = Array.isArray(result) ? result : [];
      if (!selectedEntryId || !entries.some((entry) => entry.id === selectedEntryId)) {
        selectedEntryId = entries[0]?.id || null;
      }
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
      <div class="layout">
        <div class="entry-list">
          {#each entries as entry (entry.id)}
            <button class="entry-card" class:active={selectedEntryId === entry.id} onclick={() => { selectedEntryId = entry.id; }}>
              <div class="entry-top">
                <div class="entry-title">{entry.label || entry.tool || entry.id}</div>
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
            </button>
          {/each}
        </div>

        <div class="detail-pane">
          {#if selectedEntry}
            <div class="detail-top">
              <div>
                <div class="entry-title">{selectedEntry.label || selectedEntry.id}</div>
                <div class="entry-meta">
                  <span>{selectedEntry.id}</span>
                  <span>offline</span>
                </div>
              </div>
              <button class="resurrect-btn" onclick={() => resurrect(selectedEntry)}>resurrect</button>
            </div>

            <div class="detail-grid">
              <div class="detail-row"><span class="detail-key">Tool</span><span>{selectedEntry.tool}</span></div>
              <div class="detail-row"><span class="detail-key">Config</span><span>{selectedEntry.toolConfigKey}</span></div>
              {#if selectedEntry.worktreePath}
                <div class="detail-row"><span class="detail-key">Worktree</span><span>{selectedEntry.worktreePath.split("/").pop()}</span></div>
                <div class="detail-row detail-block"><span class="detail-key">Path</span><span>{selectedEntry.worktreePath}</span></div>
              {/if}
              {#if selectedEntry.backendSessionId}
                <div class="detail-row"><span class="detail-key">Backend</span><span>{selectedEntry.backendSessionId}</span></div>
              {/if}
              <div class="detail-row detail-block"><span class="detail-key">Command</span><span>{selectedEntry.command}</span></div>
              {#if selectedEntry.args?.length}
                <div class="detail-row detail-block"><span class="detail-key">Args</span><span>{selectedEntry.args.join(" ")}</span></div>
              {/if}
              {#if selectedEntry.headline}
                <div class="detail-row detail-block"><span class="detail-key">Headline</span><span>{selectedEntry.headline}</span></div>
              {/if}
            </div>
          {:else}
            <div class="empty">Select a graveyarded agent.</div>
          {/if}
        </div>
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
    min-height: 0;
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
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 16px 16px;
  }

  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 12px;
    min-height: 0;
  }

  .entry-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: auto;
  }

  .entry-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(15, 23, 34, 0.7);
    padding: 12px;
    text-align: left;
  }

  .entry-card.active {
    background: var(--bg-surface-active);
    border-color: var(--border-active);
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

  .detail-pane {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(15, 23, 34, 0.45);
    padding: 12px;
    overflow: auto;
  }

  .detail-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .detail-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .detail-row {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 10px;
    align-items: start;
  }

  .detail-key {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
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
