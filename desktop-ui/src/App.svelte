<script>
  import Sidebar from "./lib/Sidebar.svelte";
  import WorkspaceHeader from "./lib/WorkspaceHeader.svelte";
  import SessionPanel from "./lib/SessionPanel.svelte";
  import TerminalPanel from "./lib/TerminalPanel.svelte";
  import StatusBar from "./lib/StatusBar.svelte";
  import { getState, loadProjects, pollStatusline } from "./stores/state.svelte.js";

  const state = getState();

  $effect(() => {
    loadProjects();
    pollStatusline();
  });
</script>

<div class="shell">
  <Sidebar />
  <main class="workspace">
    <WorkspaceHeader />
    <div class="workspace-body">
      <SessionPanel />
      <TerminalPanel />
    </div>
    <StatusBar />
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
