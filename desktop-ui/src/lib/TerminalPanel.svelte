<script>
  import { onMount } from "svelte";
  import "@xterm/xterm/css/xterm.css";
  import { createTerminal, getTerminal } from "./terminal-instance.svelte.js";
  import { getState, resizeTerminal, writeTerminal } from "../stores/state.svelte.js";

  const state = getState();
  let containerEl;

  onMount(() => {
    const { terminal, fitAddon } = createTerminal(containerEl);

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

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResize);
      terminal.dispose();
    };
  });
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Terminal</span>
    <span class="status">{state.terminalStatus}</span>
  </div>
  <div class="terminal-container" bind:this={containerEl}></div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
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

  .terminal-container :global(.xterm) {
    height: 100%;
  }
</style>
