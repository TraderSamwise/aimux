<script>
  import { getState, openTerminalDashboard, restartControlPlane, selectInteractionMode } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const state = getState();
  const termInstance = getTerminal();
  const modes = ["terminal", "native-chat"];

  let flash = $derived(state.statusline?.flash);
  let tasks = $derived(state.statusline?.tasks);
  let hasTasks = $derived(tasks && (tasks.pending > 0 || tasks.assigned > 0));
  let controlPlane = $derived(state.controlPlane);
  let controlPlaneLabel = $derived.by(() => {
    if (!controlPlane) return "Control";
    if (controlPlane.status === "down") return "Control Down";
    if (controlPlane.status === "outdated") return "Control Outdated";
    if (controlPlane.status === "degraded") return "Control Degraded";
    return "Control OK";
  });

  async function openDashboard() {
    const project = state.selectedProject;
    if (!project || !termInstance.terminal) return;
    await openTerminalDashboard(
      termInstance.terminal,
      project.path,
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
    <button class="pill pill-control" class:down={controlPlane?.status === "down"} class:degraded={controlPlane?.status === "degraded"} class:outdated={controlPlane?.status === "outdated"} onclick={restartControlPlane}>
      {controlPlaneLabel}
    </button>
    {#if flash}
      <span class="flash">{flash}</span>
    {/if}
  </div>

  <div class="header-right">
    <div class="mode-toggle">
      {#each modes as mode}
        <button
          class="mode-btn"
          class:active={state.interactionMode === mode}
          onclick={() => selectInteractionMode(mode)}
        >
          {mode === "native-chat" ? "Native Chat" : "Terminal"}
        </button>
      {/each}
    </div>
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
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .mode-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.08);
    border: 1px solid var(--border);
  }

  .mode-btn {
    padding: 5px 10px;
    border-radius: 999px;
    font-size: 11px;
    color: var(--text-dim);
    transition: color 120ms, background 120ms;
  }

  .mode-btn:hover {
    color: var(--text-secondary);
  }

  .mode-btn.active {
    background: rgba(56, 189, 248, 0.14);
    color: var(--accent);
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

  .pill-control {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(52, 211, 153, 0.1);
    color: rgba(110, 231, 183, 0.95);
    white-space: nowrap;
    border: 1px solid rgba(52, 211, 153, 0.18);
  }

  .pill-control.degraded {
    background: rgba(251, 191, 36, 0.1);
    color: var(--yellow);
    border-color: rgba(251, 191, 36, 0.18);
  }

  .pill-control.outdated {
    background: rgba(244, 114, 182, 0.1);
    color: rgb(249, 168, 212);
    border-color: rgba(244, 114, 182, 0.18);
  }

  .pill-control.down {
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    border-color: rgba(248, 113, 113, 0.2);
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
