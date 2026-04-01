<script>
  import { getState } from "../stores/state.svelte.js";
  const appState = getState();
</script>

{#if appState.currentAction}
  <div class="action-bar">
    <span class="spinner"></span>
    <span class="action-text">{appState.currentAction}</span>
  </div>
{/if}

<style>
  .action-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 16px;
    background: rgba(56, 189, 248, 0.06);
    border-top: 1px solid rgba(125, 211, 252, 0.12);
    flex-shrink: 0;
    min-height: 28px;
  }

  .action-text {
    font-size: 11px;
    color: var(--accent);
  }

  .spinner {
    width: 10px;
    height: 10px;
    border: 1.5px solid rgba(125, 211, 252, 0.3);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
