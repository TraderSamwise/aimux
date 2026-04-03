<script>
  import { invoke } from "@tauri-apps/api/core";
  import { getState, trackAction } from "../stores/state.svelte.js";

  const appState = getState();

  let loading = $state(false);
  let saving = $state(false);
  let error = $state(null);
  let selectedSessionId = $state(null);
  let selectedPath = $state("");
  let savedContent = $state("");
  let draftContent = $state("");

  let planEntries = $derived.by(() => {
    const sessions = appState.statusline?.sessions || [];
    const metadata = appState.statusline?.metadata || {};
    return sessions
      .map((session) => ({
        session,
        meta: metadata[session.id] || null,
      }))
      .filter((entry) => entry.meta?.progress)
      .sort((a, b) => {
        const ap = a.meta.progress;
        const bp = b.meta.progress;
        const aRatio = ap.total > 0 ? ap.current / ap.total : 0;
        const bRatio = bp.total > 0 ? bp.current / bp.total : 0;
        return aRatio - bRatio;
      });
  });

  let selectedEntry = $derived.by(() => planEntries.find((entry) => entry.session.id === selectedSessionId) || null);
  let dirty = $derived.by(() => draftContent !== savedContent);

  async function loadPlan(sessionId) {
    const project = appState.selectedProject;
    if (!project || !sessionId) {
      selectedPath = "";
      savedContent = "";
      draftContent = "";
      return;
    }
    loading = true;
    error = null;
    try {
      const result = await invoke("plan_read", {
        projectPath: project.path,
        sessionId,
      });
      selectedPath = String(result?.path || "");
      savedContent = String(result?.content || "");
      draftContent = String(result?.content || "");
    } catch (err) {
      const message = String(err);
      error = message;
      selectedPath = `.aimux/plans/${sessionId}.md`;
      savedContent = "";
      draftContent = "";
    } finally {
      loading = false;
    }
  }

  async function savePlan() {
    const project = appState.selectedProject;
    if (!project || !selectedSessionId) return;
    saving = true;
    error = null;
    try {
      await trackAction(
        {
          kind: "plan-save",
          message: "Saving plan...",
          projectPath: project.path,
        },
        () =>
          invoke("plan_write", {
            projectPath: project.path,
            sessionId: selectedSessionId,
            content: draftContent,
          }),
      );
      savedContent = draftContent;
    } catch (err) {
      error = String(err);
    } finally {
      saving = false;
    }
  }

  function selectPlan(sessionId) {
    if (!sessionId || sessionId === selectedSessionId) return;
    selectedSessionId = sessionId;
    void loadPlan(sessionId);
  }

  $effect(() => {
    appState.selectedProject?.path;
    const entries = planEntries;
    if (!appState.selectedProject) {
      selectedSessionId = null;
      selectedPath = "";
      savedContent = "";
      draftContent = "";
      return;
    }
    if (entries.length === 0) {
      selectedSessionId = null;
      selectedPath = "";
      savedContent = "";
      draftContent = "";
      return;
    }
    if (!selectedSessionId || !entries.some((entry) => entry.session.id === selectedSessionId)) {
      selectedSessionId = entries[0].session.id;
      void loadPlan(entries[0].session.id);
    }
  });
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Plans</span>
  </div>

  <div class="panel-body">
    {#if !appState.selectedProject}
      <div class="empty">Select a project to view plans.</div>
    {:else if planEntries.length === 0}
      <div class="empty">No tracked plan progress yet.</div>
    {:else}
      <div class="layout">
        <aside class="plan-list">
          {#each planEntries as entry (entry.session.id)}
            {@const progress = entry.meta.progress}
            <button class="plan-card" class:active={selectedSessionId === entry.session.id} onclick={() => selectPlan(entry.session.id)}>
              <div class="plan-top">
                <div class="plan-title">{entry.session.label || entry.session.tool || entry.session.id}</div>
                <div class="plan-count">{progress.current}/{progress.total}</div>
              </div>
              <div class="plan-meta">{progress.label || "plan"} · .aimux/plans/{entry.session.id}.md</div>
              <div class="progress-bar">
                <div class="progress-fill" style={`width: ${Math.min(100, (progress.current / Math.max(1, progress.total)) * 100)}%`}></div>
              </div>
            </button>
          {/each}
        </aside>

        <div class="plan-detail">
          {#if !selectedEntry}
            <div class="empty">Select a plan.</div>
          {:else}
            <div class="detail-header">
              <div>
                <div class="detail-title">{selectedEntry.session.label || selectedEntry.session.tool || selectedEntry.session.id}</div>
                <div class="detail-meta">{selectedPath || `.aimux/plans/${selectedEntry.session.id}.md`}</div>
              </div>
              <div class="detail-actions">
                {#if dirty}
                  <span class="dirty-pill">unsaved</span>
                {/if}
                <button class="save-btn" onclick={savePlan} disabled={saving || !dirty}>
                  {saving ? "saving..." : "save"}
                </button>
              </div>
            </div>

            {#if loading}
              <div class="empty">Loading plan…</div>
            {:else}
              <textarea class="editor" bind:value={draftContent} placeholder="Plan content…"></textarea>
            {/if}

            {#if error}
              <div class="error">{error}</div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .panel-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }

  .panel-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: 12px 16px 16px;
  }

  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 12px;
    height: 100%;
    min-height: 0;
  }

  .plan-list {
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .plan-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(15, 23, 34, 0.7);
    padding: 12px;
    text-align: left;
  }

  .plan-card.active {
    background: var(--bg-surface-active);
    border-color: var(--border-active);
  }

  .plan-top {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .plan-title,
  .detail-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .plan-count,
  .plan-meta,
  .detail-meta {
    font-size: 11px;
    color: var(--text-dim);
  }

  .plan-meta,
  .detail-meta {
    margin-top: 6px;
  }

  .progress-bar {
    margin-top: 10px;
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.1);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #38bdf8, #7dd3fc);
  }

  .plan-detail {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(15, 23, 34, 0.45);
    overflow: hidden;
  }

  .detail-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }

  .detail-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .dirty-pill {
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid rgba(251, 191, 36, 0.22);
    background: rgba(251, 191, 36, 0.12);
    color: rgb(253, 224, 71);
    font-size: 11px;
  }

  .save-btn {
    padding: 6px 11px;
    border-radius: 999px;
    border: 1px solid rgba(125, 211, 252, 0.25);
    background: rgba(56, 189, 248, 0.1);
    color: var(--accent);
    font-size: 11px;
  }

  .save-btn:disabled {
    opacity: 0.55;
  }

  .editor {
    flex: 1;
    min-height: 0;
    resize: none;
    border: 0;
    outline: none;
    padding: 14px;
    background: transparent;
    color: var(--text);
    font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    overflow: auto;
    white-space: pre-wrap;
  }

  .empty,
  .error {
    padding: 24px 14px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .error {
    color: var(--red);
  }
</style>
