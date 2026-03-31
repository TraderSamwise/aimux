<script>
  import { getState, runTerminal } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const state = getState();
  const termInstance = getTerminal();

  async function openDashboard() {
    const project = state.selectedProject;
    if (!project || !termInstance.terminal) return;
    await runTerminal(
      termInstance.terminal,
      project.path,
      ["desktop", "open", "--project", project.path],
      `Dashboard · ${project.name}`,
    );
  }
</script>

<header class="header">
  <div class="header-info">
    {#if state.selectedProject}
      <h2 class="title">{state.selectedProject.name}</h2>
      <span class="subtitle">
        {state.selectedProject.sessions.length} session{state.selectedProject.sessions.length === 1 ? "" : "s"}
        &middot; {state.selectedProject.path.replace(/^\/Users\/[^/]+\//, "~/")}
      </span>
    {:else}
      <h2 class="title">Select a project</h2>
      <span class="subtitle">Choose a project from the sidebar to get started.</span>
    {/if}
  </div>
  <div class="header-actions">
    <button
      class="action-btn"
      disabled={!state.selectedProject}
      onclick={openDashboard}
    >
      Open dashboard
    </button>
  </div>
</header>

<style>
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 16px;
  }

  .header-info {
    min-width: 0;
  }

  .title {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
  }

  .subtitle {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .action-btn {
    padding: 7px 16px;
    border-radius: var(--radius);
    background: rgba(56, 189, 248, 0.12);
    border: 1px solid rgba(125, 211, 252, 0.25);
    color: var(--accent);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    transition: background 120ms, border-color 120ms;
  }

  .action-btn:hover:enabled {
    background: rgba(56, 189, 248, 0.2);
    border-color: rgba(125, 211, 252, 0.45);
  }
</style>
