<script>
  import { onMount } from "svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import WorkspaceHeader from "./lib/WorkspaceHeader.svelte";
  import WorktreePanel from "./lib/WorktreePanel.svelte";
  import TerminalPanel from "./lib/TerminalPanel.svelte";
  import StatusBar from "./lib/StatusBar.svelte";
  import ActionBar from "./lib/ActionBar.svelte";
  import ActivityPanel from "./lib/ActivityPanel.svelte";
  import ThreadsPanel from "./lib/ThreadsPanel.svelte";
  import PlansPanel from "./lib/PlansPanel.svelte";
  import GraveyardPanel from "./lib/GraveyardPanel.svelte";
  import { getState, startHeartbeat, stopHeartbeat } from "./stores/state.svelte.js";

  const state = getState();
  let selectedScreen = $derived.by(() => state.selectedScreen || "dashboard");

  onMount(() => {
    startHeartbeat();
    return () => stopHeartbeat();
  });
</script>

<div class="shell">
  <Sidebar />
  <main class="workspace">
    <WorkspaceHeader />
    <div class="workspace-stack">
      <div class="workspace-body" class:active={selectedScreen === "dashboard"} class:inactive={selectedScreen !== "dashboard"}>
        <WorktreePanel />
        <TerminalPanel visible={selectedScreen === "dashboard"} />
      </div>

      <div class="secondary-body" class:active={selectedScreen !== "dashboard"} class:inactive={selectedScreen === "dashboard"}>
        {#if selectedScreen === "activity"}
          <ActivityPanel visible={true} />
        {:else if selectedScreen === "threads"}
          <ThreadsPanel visible={true} />
        {:else if selectedScreen === "plans"}
          <PlansPanel />
        {:else if selectedScreen === "graveyard"}
          <GraveyardPanel visible={true} />
        {/if}
      </div>
    </div>
    <StatusBar />
    <ActionBar />
  </main>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 260px 1fr;
    height: 100vh;
    overflow: hidden;
  }

  .workspace {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .workspace-stack {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .workspace-body {
    display: grid;
    grid-template-columns: 300px 1fr;
    position: absolute;
    inset: 0;
    min-height: 0;
    overflow: hidden;
  }

  .secondary-body {
    position: absolute;
    inset: 0;
    min-height: 0;
    overflow: hidden;
  }

  .active {
    visibility: visible;
    pointer-events: auto;
  }

  .inactive {
    visibility: hidden;
    pointer-events: none;
  }
</style>
