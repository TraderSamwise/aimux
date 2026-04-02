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
    {#if selectedScreen === "dashboard"}
      <div class="workspace-body">
        <WorktreePanel />
        <TerminalPanel />
      </div>
    {:else if selectedScreen === "activity"}
      <ActivityPanel visible={true} />
    {:else if selectedScreen === "threads"}
      <ThreadsPanel visible={true} />
    {:else if selectedScreen === "plans"}
      <PlansPanel />
    {:else if selectedScreen === "graveyard"}
      <GraveyardPanel visible={true} />
    {/if}
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

  .workspace-body {
    display: grid;
    grid-template-columns: 300px 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
