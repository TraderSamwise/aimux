<script>
  import { onMount } from "svelte";
  import "@xterm/xterm/css/xterm.css";
  import { createTerminal } from "./terminal-instance.svelte.js";
  import {
    getState,
    openSession,
    openTerminalDashboard,
    resizeTerminal,
    writeTerminal,
  } from "../stores/state.svelte.js";

  let { visible = false } = $props();

  const appState = getState();
  let containerEl;
  let mountedTerminal = null;
  let mountedFitAddon = null;
  let showSwitchOverlay = $state(false);
  let switchOverlayTimer = null;

  async function syncTerminalTarget() {
    if (!visible || !mountedTerminal) return;
    const project = appState.selectedProject;
    if (!project?.path) return;
    if (appState.selectedSessionId) {
      const session =
        (project.sessions || []).find((entry) => entry.id === appState.selectedSessionId) || null;
      await openSession(
        mountedTerminal,
        project.path,
        appState.selectedSessionId,
        session?.label || session?.tool || appState.selectedSessionId,
      );
      return;
    }
    await openTerminalDashboard(mountedTerminal, project.path, project.name || project.path);
  }

  onMount(() => {
    const { terminal, fitAddon } = createTerminal(containerEl);
    mountedTerminal = terminal;
    mountedFitAddon = fitAddon;

    terminal.writeln("\x1b[38;5;75mAimux Desktop Shell\x1b[0m");
    terminal.writeln("");
    terminal.writeln("Select a project, then open the dashboard or focus a session.");

    terminal.onData((data) => {
      writeTerminal(data);
    });

    const onResize = () => {
      fitAddon.fit();
      resizeTerminal(terminal);
    };

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(containerEl);
    window.addEventListener("resize", onResize);

    queueMicrotask(() => {
      void syncTerminalTarget();
    });

    return () => {
      if (switchOverlayTimer) {
        clearTimeout(switchOverlayTimer);
        switchOverlayTimer = null;
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResize);
      terminal.dispose();
    };
  });

  $effect(() => {
    if (!visible || !mountedTerminal || !mountedFitAddon) return;
    requestAnimationFrame(() => {
      mountedFitAddon.fit();
      resizeTerminal(mountedTerminal);
    });
  });

  $effect(() => {
    const switching = visible && appState.terminalSwitching;
    if (switching) {
      if (!switchOverlayTimer) {
        switchOverlayTimer = setTimeout(() => {
          showSwitchOverlay = true;
          switchOverlayTimer = null;
        }, 140);
      }
      return;
    }

    if (switchOverlayTimer) {
      clearTimeout(switchOverlayTimer);
      switchOverlayTimer = null;
    }
    showSwitchOverlay = false;
  });
</script>

<section class="panel" class:hidden={!visible}>
  <div class="panel-header">
    <span class="section-label">Terminal</span>
    <span class="status">{appState.terminalStatus}</span>
  </div>
  <div class="terminal-shell">
    <div class="terminal-container" bind:this={containerEl}></div>
    {#if showSwitchOverlay}
      <div class="terminal-overlay">
        <div class="terminal-overlay-card">
          <div class="terminal-overlay-kicker">Switching</div>
          <div class="terminal-overlay-title">{appState.terminalStatus}</div>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .panel {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
  }

  .panel.hidden {
    visibility: hidden;
    pointer-events: none;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
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

  .status {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .terminal-container {
    flex: 1;
    min-height: 0;
    padding: 0 12px 12px;
  }

  .terminal-shell {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .terminal-container :global(.xterm) {
    height: 100%;
  }

  .terminal-overlay {
    position: absolute;
    inset: 0 12px 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(180deg, rgba(9, 14, 24, 0.82), rgba(9, 14, 24, 0.9));
    border: 1px solid rgba(125, 211, 252, 0.12);
    border-radius: 12px;
    backdrop-filter: blur(2px);
    z-index: 5;
    pointer-events: none;
  }

  .terminal-overlay-card {
    padding: 18px 22px;
    border-radius: 16px;
    border: 1px solid rgba(125, 211, 252, 0.2);
    background: rgba(8, 13, 22, 0.88);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
    text-align: center;
  }

  .terminal-overlay-kicker {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--accent);
  }

  .terminal-overlay-title {
    margin-top: 8px;
    font-size: 14px;
    color: var(--text);
  }
</style>
