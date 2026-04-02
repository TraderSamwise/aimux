<script>
  import { getState, restartDaemonControl, restartProjectService } from "../stores/state.svelte.js";
  const appState = getState();

  let actions = $derived(appState.inFlightActions || []);
  let primaryAction = $derived(actions.length > 0 ? actions[actions.length - 1] : null);
  let currentAlert = $derived(appState.currentAlert);
  let idle = $derived(!primaryAction);
  let controlPlane = $derived(appState.controlPlane || {});
  let daemonStatus = $derived(controlPlane.daemonStatus || "down");
  let projectStatus = $derived(controlPlane.projectStatus || "degraded");
  let projectSelected = $derived(Boolean(appState.selectedProject));
  let alertKind = $derived(currentAlert?.kind || null);
  function alertTone(kind) {
    if (kind === "task_done") return "success";
    if (kind === "task_failed" || kind === "blocked") return "error";
    if (kind === "message_waiting") return "message";
    if (kind === "handoff_waiting") return "handoff";
    if (kind === "task_assigned" || kind === "review_waiting" || kind === "needs_input") return "waiting";
    return "waiting";
  }
  function alertPrefix(kind) {
    if (kind === "message_waiting") return "Message";
    if (kind === "handoff_waiting") return "Handoff";
    if (kind === "task_assigned") return "Task";
    if (kind === "review_waiting") return "Review";
    if (kind === "needs_input") return "Input";
    if (kind === "task_done") return "Done";
    if (kind === "task_failed") return "Failed";
    if (kind === "blocked") return "Blocked";
    return "Alert";
  }
  let alertToneKind = $derived(alertTone(alertKind));
  let alertText = $derived.by(() => {
    if (!currentAlert) return null;
    const project = (appState.projects || []).find((entry) => entry.id === currentAlert.projectId);
    const projectName = project?.name || null;
    const sessionPart = currentAlert.sessionId ? `${currentAlert.sessionId}` : projectName;
    const prefix = alertPrefix(currentAlert.kind);
    const detail = currentAlert.message || currentAlert.title || currentAlert.kind;
    return sessionPart
      ? `${prefix} · ${sessionPart} · ${detail}`
      : `${prefix} · ${detail}`;
  });
  let daemonButtonLabel = $derived.by(() => {
    if (daemonStatus === "ok") return "Daemon OK";
    return "Daemon Down · Restart";
  });
  let projectButtonLabel = $derived.by(() => {
    if (!projectSelected) return "Project Unselected";
    if (projectStatus === "ok") return "Project OK · Restart";
    if (projectStatus === "outdated") return "Project Outdated · Restart";
    return "Project Degraded · Restart";
  });
  let controlHint = $derived.by(() => {
    if (daemonStatus !== "ok") return "Daemon is disconnected.";
    if (!projectSelected) return null;
    if (projectStatus === "outdated") return "Project service is outdated for this desktop build.";
    if (projectStatus === "degraded") return "Project service is degraded.";
    return null;
  });
</script>

<div
  class="action-bar"
  class:idle
  class:alerting={!primaryAction && !!currentAlert}
  data-alert-kind={alertKind || ""}
  data-alert-tone={alertToneKind || ""}
>
  <div class="action-main">
    {#if primaryAction}
      <span class="spinner"></span>
      <span class="action-text">{primaryAction.message}</span>
      {#if actions.length > 1}
        <span class="action-count">+{actions.length - 1}</span>
      {/if}
    {:else if currentAlert}
      <span class="alert-dot" aria-hidden="true"></span>
      <span class="action-text alert-text">{alertText}</span>
    {:else}
      <span class="spinner ghost"></span>
      <span class="action-text idle-text">{controlHint || "Ready"}</span>
    {/if}
  </div>
  <div class="action-right">
    <button
      class="control-btn daemon"
      class:down={daemonStatus !== "ok"}
      onclick={restartDaemonControl}
    >
      {daemonButtonLabel}
    </button>
    <button
      class="control-btn project"
      class:degraded={projectStatus === "degraded"}
      class:outdated={projectStatus === "outdated"}
      disabled={!projectSelected}
      onclick={restartProjectService}
    >
      {projectButtonLabel}
    </button>
  </div>
</div>

<style>
  .action-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
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

  .action-bar.alerting {
    background: rgba(251, 191, 36, 0.07);
    border-top-color: rgba(251, 191, 36, 0.16);
  }

  .action-bar.alerting[data-alert-tone="success"] {
    background: rgba(74, 222, 128, 0.07);
    border-top-color: rgba(74, 222, 128, 0.18);
  }

  .action-bar.alerting[data-alert-tone="error"] {
    background: rgba(248, 113, 113, 0.08);
    border-top-color: rgba(248, 113, 113, 0.18);
  }

  .action-bar.alerting[data-alert-tone="message"] {
    background: rgba(56, 189, 248, 0.08);
    border-top-color: rgba(56, 189, 248, 0.18);
  }

  .action-bar.alerting[data-alert-tone="handoff"] {
    background: rgba(45, 212, 191, 0.09);
    border-top-color: rgba(45, 212, 191, 0.2);
  }

  .action-main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .action-right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-shrink: 0;
  }

  .action-text {
    font-size: 11px;
    color: var(--accent);
    min-width: 0;
  }

  .idle-text {
    color: var(--text-dim);
  }

  .alert-text {
    color: rgba(255, 244, 214, 0.96);
  }

  .action-bar.alerting[data-alert-tone="success"] .alert-text {
    color: rgba(220, 252, 231, 0.98);
  }

  .action-bar.alerting[data-alert-tone="error"] .alert-text {
    color: rgba(254, 226, 226, 0.98);
  }

  .action-bar.alerting[data-alert-tone="message"] .alert-text {
    color: rgba(224, 242, 254, 0.98);
  }

  .action-bar.alerting[data-alert-tone="handoff"] .alert-text {
    color: rgba(204, 251, 241, 0.98);
  }

  .alert-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: rgb(251, 191, 36);
    box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.14);
    flex-shrink: 0;
  }

  .action-bar.alerting[data-alert-tone="success"] .alert-dot {
    background: rgb(74, 222, 128);
    box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.14);
  }

  .action-bar.alerting[data-alert-tone="error"] .alert-dot {
    background: rgb(248, 113, 113);
    box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.14);
  }

  .action-bar.alerting[data-alert-tone="message"] .alert-dot {
    background: rgb(56, 189, 248);
    box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.14);
  }

  .action-bar.alerting[data-alert-tone="handoff"] .alert-dot {
    background: rgb(45, 212, 191);
    box-shadow: 0 0 0 4px rgba(45, 212, 191, 0.14);
  }

  .action-count {
    font-size: 10px;
    color: var(--text-dim);
  }

  .control-btn {
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
    opacity: 0.5;
  }

  .control-btn.daemon.down {
    color: var(--red);
    background: rgba(248, 113, 113, 0.08);
    border-color: rgba(248, 113, 113, 0.18);
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
    filter: brightness(1.12);
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
