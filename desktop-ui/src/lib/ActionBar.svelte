<script>
  import {
    getState,
    repairProjectRuntime,
    restartProjectRuntime,
    setNotificationPanelOpen,
  } from "../stores/state.svelte.js";
  const appState = getState();

  let actions = $derived(appState.inFlightActions || []);
  let primaryAction = $derived(actions.length > 0 ? actions[actions.length - 1] : null);
  let currentAlert = $derived(appState.currentAlert);
  let selectedProject = $derived(appState.selectedProject || null);
  let notificationSummary = $derived(appState.notificationSummary || { unreadCount: 0, unreadBySession: {} });
  let totalUnreadNotifications = $derived(appState.totalUnreadNotifications || 0);
  let idle = $derived(!primaryAction);
  let controlPlane = $derived(appState.controlPlane || {});
  let daemonStatus = $derived(controlPlane.daemonStatus || "down");
  let projectStatus = $derived(controlPlane.projectStatus || "degraded");
  let projectSelected = $derived(Boolean(appState.selectedProject));
  let controlReason = $derived(controlPlane.reason || null);
  let controlError = $derived(controlPlane.error || null);
  let alertKind = $derived(currentAlert?.kind || null);
  function alertTone(kind) {
    if (kind === "notification") return "message";
    if (kind === "task_done") return "success";
    if (kind === "task_failed" || kind === "blocked") return "error";
    if (kind === "message_waiting") return "message";
    if (kind === "handoff_waiting") return "handoff";
    if (kind === "task_assigned" || kind === "review_waiting" || kind === "needs_input") return "waiting";
    return "waiting";
  }
  function alertPrefix(kind) {
    if (kind === "notification") return "Alert";
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
  let projectStatusLabel = $derived.by(() => {
    if (!projectSelected) return "Project Unselected";
    if (projectStatus === "ok") return "Project Runtime · Healthy";
    if (projectStatus === "outdated") return "Project Runtime · Needs Repair";
    return "Project Runtime · Degraded";
  });
  let repairButtonLabel = $derived.by(() => {
    if (!projectSelected) return "Repair Runtime";
    if (projectStatus === "ok") return "Repair Runtime";
    return "Repair Runtime";
  });
  let controlHint = $derived.by(() => {
    const selectedUnread = Number(notificationSummary?.unreadCount || 0);
    if (selectedUnread > 0) return `${selectedUnread} unread notification${selectedUnread === 1 ? "" : "s"}`;
    if (totalUnreadNotifications > 0) return `${totalUnreadNotifications} unread notification${totalUnreadNotifications === 1 ? "" : "s"} across projects`;
    if (controlError) return controlError;
    if (controlReason) return controlReason;
    return null;
  });

  let panelOpen = $state(false);
  let panelLoading = $state(false);
  let panelError = $state(null);
  let panelNotifications = $state([]);

  async function loadNotifications() {
    const endpoint = selectedProject?.serviceEndpoint || null;
    if (!endpoint?.host || !endpoint?.port) {
      panelNotifications = [];
      return;
    }
    panelLoading = true;
    panelError = null;
    try {
      const res = await fetch(`http://${endpoint.host}:${endpoint.port}/notifications`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      panelNotifications = json.notifications || [];
    } catch (error) {
      panelError = String(error);
    } finally {
      panelLoading = false;
    }
  }

  async function markNotificationRead(notification) {
    const endpoint = selectedProject?.serviceEndpoint || null;
    if (!endpoint?.host || !endpoint?.port || !notification?.id) return;
    await fetch(`http://${endpoint.host}:${endpoint.port}/notifications/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: notification.id }),
    }).catch(() => {});
    await loadNotifications();
  }

  async function clearNotifications(input = {}) {
    const endpoint = selectedProject?.serviceEndpoint || null;
    if (!endpoint?.host || !endpoint?.port) return;
    await fetch(`http://${endpoint.host}:${endpoint.port}/notifications/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).catch(() => {});
    await loadNotifications();
  }

  async function togglePanel() {
    panelOpen = !panelOpen;
    setNotificationPanelOpen(panelOpen);
    if (panelOpen) {
      await loadNotifications();
    }
  }

  function notificationTimestamp(notification) {
    const value = notification?.createdAt || notification?.updatedAt || "";
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  $effect(() => {
    if (!panelOpen) return;
    currentAlert;
    selectedProject?.path;
    void loadNotifications();
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
      class="control-btn notifications"
      class:active={panelOpen}
      onclick={() => { void togglePanel(); }}
    >
      Inbox{totalUnreadNotifications > 0 ? ` · ${totalUnreadNotifications}` : ""}
    </button>
    <button
      class="control-btn runtime-status"
      class:degraded={projectStatus === "degraded"}
      class:outdated={projectStatus === "outdated"}
      disabled={true}
    >
      {projectStatusLabel}
    </button>
    <button
      class="control-btn project"
      class:degraded={projectStatus !== "ok"}
      disabled={!projectSelected}
      onclick={() => { void repairProjectRuntime({ auto: false }).catch(() => {}); }}
    >
      {repairButtonLabel}
    </button>
    <button
      class="control-btn project restart-runtime"
      disabled={!projectSelected}
      onclick={() => { void restartProjectRuntime().catch(() => {}); }}
    >
      Restart Runtime
    </button>
  </div>
  {#if panelOpen}
    <div class="notification-panel">
      <div class="notification-panel-header">
        <div>
          <div class="panel-title">Notifications</div>
          <div class="panel-subtitle">{selectedProject?.name || "No project selected"}</div>
        </div>
        <button class="panel-action" onclick={() => { void clearNotifications(); }}>Clear all</button>
      </div>
      {#if panelLoading}
        <div class="notification-empty">Loading…</div>
      {:else if panelError}
        <div class="notification-empty error">{panelError}</div>
      {:else if panelNotifications.length === 0}
        <div class="notification-empty">No notifications.</div>
      {:else}
        <div class="notification-list">
          {#each panelNotifications as notification (notification.id)}
            <div class="notification-item" class:unread={notification.unread}>
              <div class="notification-copy">
                <div class="notification-head">
                  <span class="notification-title">{notification.title}</span>
                  <span class="notification-time">{notificationTimestamp(notification)}</span>
                </div>
                {#if notification.subtitle}
                  <div class="notification-subtitle">{notification.subtitle}</div>
                {/if}
                <div class="notification-body">{notification.body}</div>
              </div>
              <div class="notification-actions">
                {#if notification.unread}
                  <button class="panel-action" onclick={() => { void markNotificationRead(notification); }}>Read</button>
                {/if}
                <button class="panel-action" onclick={() => { void clearNotifications({ id: notification.id }); }}>Clear</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .action-bar {
    position: relative;
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

  .control-btn.notifications.active {
    color: rgba(191, 219, 254, 0.96);
    background: rgba(59, 130, 246, 0.12);
    border-color: rgba(59, 130, 246, 0.2);
  }

  .notification-panel {
    position: absolute;
    right: 16px;
    bottom: calc(100% + 10px);
    width: min(460px, calc(100% - 32px));
    max-height: 420px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border-radius: 16px;
    border: 1px solid rgba(148, 163, 184, 0.14);
    background: rgba(10, 14, 22, 0.97);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.38);
    z-index: 20;
  }

  .notification-panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .panel-title {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text);
  }

  .panel-subtitle {
    margin-top: 3px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .notification-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: auto;
  }

  .notification-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid rgba(148, 163, 184, 0.08);
    background: rgba(255, 255, 255, 0.02);
  }

  .notification-item.unread {
    border-color: rgba(96, 165, 250, 0.22);
    background: rgba(59, 130, 246, 0.08);
  }

  .notification-copy {
    min-width: 0;
    flex: 1;
  }

  .notification-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .notification-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }

  .notification-time {
    font-size: 10px;
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .notification-subtitle {
    margin-top: 2px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .notification-body {
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.45;
  }

  .notification-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }

  .panel-action {
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 999px;
    color: var(--text-secondary);
    background: rgba(148, 163, 184, 0.08);
    border: 1px solid rgba(148, 163, 184, 0.14);
  }

  .notification-empty {
    padding: 16px 8px 8px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .notification-empty.error {
    color: var(--red);
  }
</style>
