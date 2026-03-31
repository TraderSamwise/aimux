<script>
  import { getState, selectSession, runTerminal } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const state = getState();
  const termInstance = getTerminal();

  // Merge session list with per-session metadata from statusline
  let sessions = $derived.by(() => {
    const sl = state.statusline;
    if (!sl?.sessions) return [];
    const meta = sl.metadata || {};
    return sl.sessions.map((s) => ({
      ...s,
      meta: meta[s.id] || null,
    }));
  });

  // The focused session's metadata (for the right-side detail)
  let focusedMeta = $derived.by(() => {
    if (!state.selectedSessionId || !state.statusline?.metadata) return null;
    return state.statusline.metadata[state.selectedSessionId] || null;
  });

  let focusedSession = $derived.by(() => {
    if (!state.selectedSessionId) return null;
    return sessions.find((s) => s.id === state.selectedSessionId) || null;
  });

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
    selectSession(session.id);
    const project = state.selectedProject;
    if (!project || !termInstance.terminal) return;
    await runTerminal(
      termInstance.terminal,
      project.path,
      ["desktop", "focus", "--project", project.path, "--session", session.id],
      chipLabel(session),
    );
  }

  function progressText(meta) {
    if (!meta?.progress) return null;
    const p = meta.progress;
    const label = p.label ? `${p.label} ` : "";
    return `${label}${p.current}/${p.total}`;
  }

  function detailText(meta, session) {
    if (!meta) return null;
    // Priority: headline > status.text > progress > last event
    if (session?.headline) return session.headline;
    if (meta.status?.text) return meta.status.text;
    if (meta.progress) return progressText(meta);
    if (meta.derived?.lastEvent?.message) return meta.derived.lastEvent.message;
    return null;
  }
</script>

{#if sessions.length > 0}
  <footer class="statusbar">
    <div class="chips">
      {#each sessions as session (session.id)}
        {@const b = badge(session.meta?.derived)}
        {@const active = session.id === state.selectedSessionId}
        {@const isCurrent = session.active}
        <button
          class="chip"
          class:active
          class:current={isCurrent}
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
  </footer>
{/if}

<style>
  .statusbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 36px;
    background: rgba(10, 15, 22, 0.6);
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

  .chip.current:not(.active) {
    border-color: rgba(148, 163, 184, 0.25);
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
</style>
