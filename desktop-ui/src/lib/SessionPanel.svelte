<script>
  import { getState, openSession } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const state = getState();
  const termInstance = getTerminal();

  async function focusSession(session) {
    const project = state.selectedProject;
    if (!project) return;
    await openSession(
      termInstance.terminal,
      project.path,
      session.id,
      `${session.label || session.id}`,
    );
  }

  function statusColor(status) {
    if (status === "running" || status === "live") return "var(--green)";
    if (status === "waiting") return "var(--yellow)";
    return "var(--text-dim)";
  }
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Sessions</span>
    {#if state.selectedProject}
      <span class="count">{state.selectedProject.sessions.length}</span>
    {/if}
  </div>

  <div class="session-list">
    {#if !state.selectedProject}
      <div class="empty">Select a project to view sessions.</div>
    {:else if state.selectedProject.sessions.length === 0}
      <div class="empty">No sessions yet.</div>
    {:else}
      {#each state.selectedProject.sessions as session (session.id)}
        {@const active = session.id === state.selectedSessionId}
        <button
          class="session-card"
          class:active
          onclick={() => focusSession(session)}
        >
          <div class="session-top">
            <span class="session-name">{session.label || session.id}</span>
            <span class="status-dot" style="background: {statusColor(session.status)}"></span>
          </div>
          <div class="session-meta">
            {session.tool}{#if session.role} &middot; {session.role}{/if}
          </div>
          {#if session.headline}
            <div class="session-headline">{session.headline}</div>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</section>

<style>
  .panel {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    flex-shrink: 0;
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }

  .count {
    font-size: 10px;
    color: var(--text-dim);
    background: rgba(148, 163, 184, 0.1);
    padding: 1px 6px;
    border-radius: 4px;
  }

  .session-list {
    overflow-y: auto;
    padding: 0 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .session-card {
    text-align: left;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    transition: background 120ms, border-color 120ms;
  }

  .session-card:hover {
    background: var(--bg-surface);
  }

  .session-card.active {
    background: var(--bg-surface-active);
    border-color: var(--border-active);
  }

  .session-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .session-name {
    font-weight: 600;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .session-meta {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 2px;
  }

  .session-headline {
    font-size: 11px;
    color: var(--text-secondary);
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    padding: 24px 16px;
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
