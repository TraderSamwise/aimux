<script>
  import { onMount } from "svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import WorkspaceHeader from "./lib/WorkspaceHeader.svelte";
  import WorktreePanel from "./lib/WorktreePanel.svelte";
  import TerminalPanel from "./lib/TerminalPanel.svelte";
  import StatusBar from "./lib/StatusBar.svelte";
  import ActionBar from "./lib/ActionBar.svelte";
  import { startHeartbeat, stopHeartbeat } from "./stores/state.svelte.js";

  onMount(() => {
    startHeartbeat();
    return () => stopHeartbeat();
  });
</script>

<div class="shell">
  <Sidebar />
  <main class="workspace">
    <WorkspaceHeader />
    <div class="workspace-body">
      <WorktreePanel />
      <TerminalPanel />
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

  .workspace-body {
    display: grid;
    grid-template-columns: 300px 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
