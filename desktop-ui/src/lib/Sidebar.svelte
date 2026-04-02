<script>
  import { getState, selectProject } from "../stores/state.svelte.js";

  const state = getState();

  function sessionCount(project) {
    return project.statusline?.sessions?.length ?? 0;
  }

  function liveCount(project) {
    return (project.statusline?.sessions ?? []).filter((s) => s.status !== "offline").length;
  }
</script>

<aside class="sidebar">
  <div class="brand">
    <span class="brand-mark">aimux</span>
    <span class="brand-label">desktop</span>
  </div>

  <div class="section-label">Projects</div>

  <div class="project-list">
    {#each state.projects as project (project.path)}
      {@const active = project.path === state.selectedProjectPath}
      {@const live = liveCount(project)}
      <button
        class="project-card"
        class:active
        onclick={() => void selectProject(project.path)}
      >
        <div class="project-name">{project.name}</div>
        <div class="project-path">{project.path.replace(/^\/Users\/[^/]+\//, "~/")}</div>
        <div class="tags">
          {#if live > 0}
            <span class="tag tag-green">{live} live</span>
          {:else if sessionCount(project) > 0}
            <span class="tag tag-dim">{sessionCount(project)} idle</span>
          {/if}
        </div>
      </button>
    {:else}
      <div class="empty">No projects found</div>
    {/each}
  </div>
</aside>

<style>
  .sidebar {
    background: #0a0f16;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 16px 12px;
    gap: 12px;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 0 4px;
  }

  .brand-mark {
    font-size: 16px;
    font-weight: 700;
    color: var(--accent);
  }

  .brand-label {
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    padding: 0 4px;
  }

  .project-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .project-card {
    text-align: left;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    transition: background 120ms, border-color 120ms;
  }

  .project-card:hover {
    background: var(--bg-surface);
  }

  .project-card.active {
    background: var(--bg-surface-active);
    border-color: var(--border-active);
  }

  .project-name {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 2px;
  }

  .project-path {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tags {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.08);
  }

  .tag-green {
    color: var(--green);
  }

  .tag-dim {
    color: var(--text-dim);
  }

  .empty {
    padding: 20px 12px;
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
