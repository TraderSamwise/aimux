<script>
  import { getState, restartControlPlane } from "../stores/state.svelte.js";
  const appState = getState();

  let actions = $derived(appState.inFlightActions || []);
  let primaryAction = $derived(actions.length > 0 ? actions[actions.length - 1] : null);
  let idle = $derived(!primaryAction);
  let controlPlane = $derived(appState.controlPlane);
  let unhealthy = $derived(controlPlane && controlPlane.status !== "ok");
  let controlButtonLabel = $derived.by(() => {
    if (!controlPlane || controlPlane.status === "ok") return "Control OK";
    if (controlPlane.status === "outdated") return "Control Outdated · Restart";
    if (controlPlane.status === "down") return "Control Down · Restart";
    return "Control Degraded · Restart";
  });
  let controlHint = $derived.by(() => {
    if (!controlPlane || controlPlane.status === "ok") return null;
    if (controlPlane.status === "outdated") return "Project service is outdated for this desktop build.";
    if (controlPlane.status === "down") return "Control plane is disconnected.";
    return "Control plane is degraded.";
  });
</script>

<div class="action-bar" class:idle>
  {#if primaryAction}
    <span class="spinner"></span>
    <span class="action-text">{primaryAction.message}</span>
    {#if actions.length > 1}
      <span class="action-count">+{actions.length - 1}</span>
    {/if}
  {:else}
    <span class="spinner ghost"></span>
    <span class="action-text idle-text">{controlHint || "Ready"}</span>
  {/if}
  <button
    class="control-btn"
    class:degraded={controlPlane?.status === "degraded"}
    class:outdated={controlPlane?.status === "outdated"}
    class:down={controlPlane?.status === "down"}
    disabled={!unhealthy}
    onclick={restartControlPlane}
  >
    {controlButtonLabel}
  </button>
</div>

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

  .action-bar.idle {
    background: rgba(255, 255, 255, 0.02);
    border-top-color: rgba(148, 163, 184, 0.08);
  }

  .action-text {
    font-size: 11px;
    color: var(--accent);
  }

  .idle-text {
    color: var(--text-dim);
  }

  .action-count {
    margin-left: auto;
    font-size: 10px;
    color: var(--text-dim);
  }

  .control-btn {
    margin-left: auto;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 999px;
    color: rgba(110, 231, 183, 0.95);
    background: rgba(52, 211, 153, 0.08);
    border: 1px solid rgba(52, 211, 153, 0.18);
    transition: background 120ms, border-color 120ms, color 120ms, opacity 120ms;
  }

  .control-btn:disabled {
    cursor: default;
    opacity: 0.9;
  }

  .control-btn.degraded {
    color: var(--yellow);
    background: rgba(251, 191, 36, 0.08);
    border-color: rgba(251, 191, 36, 0.18);
  }

  .control-btn.outdated {
    color: rgb(249, 168, 212);
    background: rgba(244, 114, 182, 0.08);
    border-color: rgba(244, 114, 182, 0.18);
  }

  .control-btn.down {
    color: var(--red);
    background: rgba(248, 113, 113, 0.08);
    border-color: rgba(248, 113, 113, 0.18);
  }

  .control-btn:not(:disabled):hover {
    background: rgba(248, 113, 113, 0.14);
    border-color: rgba(248, 113, 113, 0.28);
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

  .spinner.ghost {
    animation: none;
    border-color: rgba(148, 163, 184, 0.16);
    border-top-color: rgba(148, 163, 184, 0.16);
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
