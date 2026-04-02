<script>
  import { getState, selectScreen, openSession } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const state = getState();
  const termInstance = getTerminal();

  function sessionWorktreePath(session, meta) {
    return session?.worktreePath || meta?.context?.worktreePath || null;
  }

  let currentWorktreePath = $derived.by(() => {
    if (!state.selectedSessionId) return null;
    const sl = state.statusline;
    const selected = sl?.sessions?.find((session) => session.id === state.selectedSessionId);
    if (!selected) return null;
    const meta = sl?.metadata?.[selected.id] || null;
    return sessionWorktreePath(selected, meta);
  });

  // All sessions with merged metadata
  let sessions = $derived.by(() => {
    const sl = state.statusline;
    if (!sl?.sessions) return [];
    const meta = sl.metadata || {};
    const merged = sl.sessions.map((s) => ({
      ...s,
      meta: meta[s.id] || null,
    }));
    if (currentWorktreePath == null) {
      return merged;
    }
    return merged.filter((session) => sessionWorktreePath(session, session.meta) === currentWorktreePath);
  });

  let focusedMeta = $derived.by(() => {
    if (!state.selectedSessionId || !state.statusline?.metadata) return null;
    return state.statusline.metadata[state.selectedSessionId] || null;
  });

  let focusedSession = $derived.by(() => {
    if (!state.selectedSessionId) return null;
    return sessions.find((s) => s.id === state.selectedSessionId) || null;
  });

  let selectedScreen = $derived.by(() => state.selectedScreen || "dashboard");

  const screens = ["dashboard", "activity", "threads", "plans", "graveyard"];

  function badge(derived) {
    if (!derived) return null;
    if (derived.attention === "error") return { glyph: "\u2717", color: "var(--red)" };
    if (derived.attention === "needs_input") return { glyph: "?", color: "var(--yellow)" };
    if (derived.attention === "blocked") return { glyph: "!", color: "var(--red)" };
    if ((derived.unseenCount ?? 0) > 0) return { glyph: String(Math.min(derived.unseenCount, 9)), color: "var(--accent)" };
    if (derived.activity === "done") return { glyph: "\u2713", color: "var(--green)" };
    if (derived.activity === "running") return { glyph: "\u21bb", color: "var(--green)" };
    if (derived.activity === "waiting") return { glyph: "\u2026", color: "var(--yellow)" };
    return null;
  }

  function chipLabel(session) {
    return session.label || session.tool || session.id;
  }

  async function focusChip(session) {
    const project = state.selectedProject;
    if (!project) return;
    await openSession(
      termInstance.terminal,
      project.path,
      session.id,
      chipLabel(session),
    );
  }

  function detailText(meta, session) {
    if (!meta) return null;
    if (session?.headline) return session.headline;
    if (meta.status?.text) return meta.status.text;
    if (meta.progress) {
      const p = meta.progress;
      const label = p.label ? `${p.label} ` : "";
      return `${label}${p.current}/${p.total}`;
    }
    if (meta.derived?.lastEvent?.message) return meta.derived.lastEvent.message;
    return null;
  }
</script>

{#if state.selectedProject}
  <footer class="statusbar">
    <div class="bar-row bar-chips">
      <div class="chips">
        {#each sessions as session (session.id)}
          {@const b = badge(session.meta?.derived)}
          {@const active = session.id === state.selectedSessionId}
          <button
            class="chip"
            class:active
            onclick={() => focusChip(session)}
            title={session.id}
          >
            <span class="chip-label">{chipLabel(session)}</span>
            {#if session.role}
              <span class="chip-role">{session.role}</span>
            {/if}
            {#if b}
              <span class="chip-badge" style="color: {b.color}">{b.glyph}</span>
            {/if}
          </button>
        {/each}
      </div>

      <div class="detail">
        {#if focusedSession}
          {@const text = detailText(focusedMeta, focusedSession)}
          {#if text}
            <span class="detail-text">{text}</span>
          {/if}
          {@const progress = focusedMeta?.progress}
          {#if progress}
            <div class="progress-bar">
              <div class="progress-fill" style="width: {Math.min(100, (progress.current / Math.max(1, progress.total)) * 100)}%"></div>
            </div>
          {/if}
        {/if}
      </div>
    </div>

    <div class="bar-row bar-tabs">
      {#each screens as screen}
        <button
          class="tab"
          class:active={selectedScreen === screen}
          onclick={() => selectScreen(screen)}
        >
          {screen}
        </button>
      {/each}
    </div>
  </footer>
{/if}

<style>
  .statusbar {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: rgba(10, 15, 22, 0.6);
  }

  .bar-row {
    display: flex;
    align-items: center;
    padding: 0 16px;
    min-height: 32px;
  }

  .bar-chips {
    gap: 12px;
    padding-top: 4px;
    padding-bottom: 2px;
  }

  .bar-tabs {
    gap: 4px;
    padding-bottom: 4px;
    border-top: 1px solid rgba(148, 163, 184, 0.06);
  }

  .chips {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    flex-shrink: 0;
    max-width: 60%;
  }

  .chips::-webkit-scrollbar {
    height: 0;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 5px;
    font-size: 11px;
    white-space: nowrap;
    background: var(--bg-surface);
    border: 1px solid transparent;
    transition: background 100ms, border-color 100ms;
  }

  .chip:hover {
    background: var(--bg-surface-hover);
  }

  .chip.active {
    background: var(--bg-surface-active);
    border-color: var(--border-active);
  }

  .chip-label {
    color: var(--text);
    font-weight: 500;
  }

  .chip-role {
    color: var(--text-dim);
    font-size: 10px;
  }

  .chip-badge {
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }

  .detail {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    justify-content: flex-end;
  }

  .detail-text {
    font-size: 11px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .progress-bar {
    width: 80px;
    height: 3px;
    background: rgba(148, 163, 184, 0.12);
    border-radius: 2px;
    flex-shrink: 0;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 300ms ease;
  }

  .tab {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 5px;
    color: var(--text-dim);
    transition: color 100ms, background 100ms;
  }

  .tab:hover {
    color: var(--text-secondary);
    background: var(--bg-surface);
  }

  .tab.active {
    color: var(--text);
    background: var(--bg-surface);
  }
</style>
