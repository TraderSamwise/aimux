<script>
  import { getState } from "../stores/state.svelte.js";

  const state = getState();

  let planEntries = $derived.by(() => {
    const sessions = state.statusline?.sessions || [];
    const metadata = state.statusline?.metadata || {};
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
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Plans</span>
  </div>

  <div class="panel-body">
    {#if !state.selectedProject}
      <div class="empty">Select a project to view plans.</div>
    {:else if planEntries.length === 0}
      <div class="empty">No tracked plan progress yet.</div>
    {:else}
      <div class="plan-list">
        {#each planEntries as entry (entry.session.id)}
          {@const progress = entry.meta.progress}
          <article class="plan-card">
            <div class="plan-top">
              <div class="plan-title">{entry.session.label || entry.session.tool || entry.session.id}</div>
              <div class="plan-count">{progress.current}/{progress.total}</div>
            </div>
            <div class="plan-meta">{progress.label || "plan"} · .aimux/plans/{entry.session.id}.md</div>
            <div class="progress-bar">
              <div class="progress-fill" style={`width: ${Math.min(100, (progress.current / Math.max(1, progress.total)) * 100)}%`}></div>
            </div>
          </article>
        {/each}
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
    overflow: auto;
    padding: 12px 16px 16px;
  }

  .plan-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .plan-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(15, 23, 34, 0.7);
    padding: 12px;
  }

  .plan-top {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .plan-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .plan-count,
  .plan-meta {
    font-size: 11px;
    color: var(--text-dim);
  }

  .plan-meta {
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

  .empty {
    padding: 24px 4px;
    font-size: 12px;
    color: var(--text-dim);
  }
</style>
