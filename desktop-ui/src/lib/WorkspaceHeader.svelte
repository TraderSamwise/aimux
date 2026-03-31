<script>
  import { getState, runTerminal } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const state = getState();
  const termInstance = getTerminal();

  let flash = $derived(state.statusline?.flash);
  let tasks = $derived(state.statusline?.tasks);
  let hasTasks = $derived(tasks && (tasks.pending > 0 || tasks.assigned > 0));

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
  <div class="header-left">
    {#if state.selectedProject}
      <h2 class="title">{state.selectedProject.name}</h2>
      <span class="subtitle">
        {state.selectedProject.path.replace(/^\/Users\/[^/]+\//, "~/")}
      </span>
    {:else}
      <h2 class="title">Select a project</h2>
      <span class="subtitle">Choose a project from the sidebar.</span>
    {/if}
  </div>

  <div class="header-center">
    {#if hasTasks}
      <span class="pill pill-tasks">
        tasks {tasks.assigned}/{tasks.pending + tasks.assigned}
      </span>
    {/if}
    {#if flash}
      <span class="flash">{flash}</span>
    {/if}
  </div>

  <div class="header-right">
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
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 16px;
    min-height: 48px;
  }

  .header-left {
    min-width: 0;
    flex-shrink: 1;
  }

  .header-center {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    justify-content: center;
    min-width: 0;
  }

  .header-right {
    flex-shrink: 0;
  }

  .title {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    white-space: nowrap;
  }

  .subtitle {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .pill-tasks {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(56, 189, 248, 0.1);
    color: var(--accent);
    white-space: nowrap;
  }

  .flash {
    font-size: 11px;
    color: var(--yellow);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .action-btn {
    padding: 6px 14px;
    border-radius: var(--radius);
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(125, 211, 252, 0.2);
    color: var(--accent);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    transition: background 120ms, border-color 120ms;
  }

  .action-btn:hover:enabled {
    background: rgba(56, 189, 248, 0.18);
    border-color: rgba(125, 211, 252, 0.4);
  }
</style>
