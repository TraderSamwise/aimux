<script>
  import { onMount } from "svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import WorkspaceHeader from "./lib/WorkspaceHeader.svelte";
  import WorktreePanel from "./lib/WorktreePanel.svelte";
  import TerminalPanel from "./lib/TerminalPanel.svelte";
  import NativeChatPanel from "./lib/NativeChatPanel.svelte";
  import StatusBar from "./lib/StatusBar.svelte";
  import ActionBar from "./lib/ActionBar.svelte";
  import ActivityPanel from "./lib/ActivityPanel.svelte";
  import ThreadsPanel from "./lib/ThreadsPanel.svelte";
  import PlansPanel from "./lib/PlansPanel.svelte";
  import GraveyardPanel from "./lib/GraveyardPanel.svelte";
  import {
    getState,
    repairProjectRuntime,
    restartProjectRuntime,
    setDesktopWindowFocus,
    startHeartbeat,
    stopHeartbeat,
  } from "./stores/state.svelte.js";

  const state = getState();
  let selectedScreen = $derived.by(() => state.selectedScreen || "dashboard");
  let interactionMode = $derived.by(() => state.interactionMode || "terminal");
  let controlPlane = $derived.by(() => state.controlPlane || {});
  let showControlOverlay = $derived.by(() => {
    if (!state.selectedProject) return false;
    if (controlPlane.projectStatus === "outdated") return true;
    if (controlPlane.daemonStatus !== "ok") {
      return Number(controlPlane.heartbeatAgeMs || 0) >= 10000;
    }
    return false;
  });

  onMount(() => {
    startHeartbeat();
    const onFocus = () => setDesktopWindowFocus(true);
    const onBlur = () => setDesktopWindowFocus(false);
    const onVisibility = () => setDesktopWindowFocus(!document.hidden && document.hasFocus());
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      stopHeartbeat();
    };
  });
</script>

<div class="shell">
  <Sidebar />
  <main class="workspace">
    <WorkspaceHeader />
    <div class="workspace-stack">
      <div class="workspace-body" class:active={selectedScreen === "dashboard"} class:inactive={selectedScreen !== "dashboard"}>
        <WorktreePanel />
        <div class="surface-stack">
          {#if selectedScreen === "dashboard" && interactionMode === "terminal"}
            <TerminalPanel visible={true} />
          {:else if selectedScreen === "dashboard" && interactionMode === "native-chat"}
            <NativeChatPanel visible={true} />
          {/if}
        </div>
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
      {#if showControlOverlay}
        <div class="control-overlay">
          <div class="control-card">
            <div class="control-kicker">Control Update Required</div>
            <h3>{controlPlane.daemonStatus !== "ok" ? "Project runtime needs repair" : "Project runtime needs attention"}</h3>
            <p>{controlPlane.error || controlPlane.reason || "Repair will recover the current project runtime in place. Restart Runtime will rebuild it from scratch."}</p>
            <div class="control-actions">
              <button class="overlay-btn" onclick={() => { void repairProjectRuntime({ auto: false }).catch(() => {}); }}>Repair Runtime</button>
              <button class="overlay-btn primary" onclick={() => { void restartProjectRuntime().catch(() => {}); }}>Restart Runtime</button>
            </div>
          </div>
        </div>
      {/if}
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

  .control-overlay {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(5, 10, 18, 0.72);
    backdrop-filter: blur(4px);
  }

  .control-card {
    width: min(560px, 100%);
    padding: 20px 22px;
    border-radius: 18px;
    border: 1px solid rgba(244, 114, 182, 0.18);
    background: linear-gradient(180deg, rgba(22, 14, 24, 0.98), rgba(14, 10, 18, 0.98));
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  }

  .control-kicker {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgb(249, 168, 212);
  }

  .control-card h3 {
    margin: 10px 0 8px;
    font-size: 22px;
    font-weight: 600;
  }

  .control-card p {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .control-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 18px;
  }

  .overlay-btn {
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    background: rgba(148, 163, 184, 0.08);
    color: var(--text-secondary);
    font-size: 12px;
  }

  .overlay-btn.primary {
    border-color: rgba(244, 114, 182, 0.22);
    background: rgba(244, 114, 182, 0.12);
    color: rgb(251, 207, 232);
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
    display: flex;
    flex-direction: column;
    position: absolute;
    inset: 0;
    min-height: 0;
    overflow: hidden;
  }

  .surface-stack {
    position: relative;
    min-width: 0;
    min-height: 0;
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
