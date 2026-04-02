<script>
  import { invoke } from "@tauri-apps/api/core";
  import { getState } from "../stores/state.svelte.js";

  let { visible = false } = $props();

  const state = getState();

  let loading = $state(false);
  let error = $state(null);
  let threads = $state([]);
  let selectedThreadId = $state(null);
  let selectedThread = $state(null);
  let threadMessages = $state([]);

  async function loadThreads() {
    const project = state.selectedProject;
    if (!visible || !project) {
      threads = [];
      selectedThreadId = null;
      selectedThread = null;
      threadMessages = [];
      return;
    }
    loading = true;
    error = null;
    try {
      const result = await invoke("threads_list", { projectPath: project.path, sessionId: null });
      threads = Array.isArray(result?.threads) ? result.threads : [];
      if (!selectedThreadId || !threads.some((entry) => entry.thread?.id === selectedThreadId)) {
        selectedThreadId = threads[0]?.thread?.id || null;
      }
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  async function loadThreadDetail() {
    const project = state.selectedProject;
    if (!visible || !project || !selectedThreadId) {
      selectedThread = null;
      threadMessages = [];
      return;
    }
    try {
      const result = await invoke("thread_get", { projectPath: project.path, threadId: selectedThreadId });
      selectedThread = result?.thread || null;
      threadMessages = Array.isArray(result?.messages) ? result.messages : [];
    } catch (err) {
      error = String(err);
    }
  }

  $effect(() => {
    state.selectedProject?.path;
    state.projects;
    if (visible) {
      void loadThreads();
    }
  });

  $effect(() => {
    selectedThreadId;
    if (visible) {
      void loadThreadDetail();
    }
  });
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Threads</span>
  </div>

  <div class="thread-layout">
    <aside class="thread-list">
      {#if !state.selectedProject}
        <div class="empty">Select a project to view threads.</div>
      {:else if loading && threads.length === 0}
        <div class="empty">Loading threads…</div>
      {:else if error}
        <div class="error">{error}</div>
      {:else if threads.length === 0}
        <div class="empty">No threads yet.</div>
      {:else}
        {#each threads as entry (entry.thread.id)}
          <button
            class="thread-chip"
            class:active={selectedThreadId === entry.thread.id}
            onclick={() => { selectedThreadId = entry.thread.id; }}
          >
            <div class="thread-chip-title">{entry.thread.title || entry.thread.id}</div>
            <div class="thread-chip-meta">{entry.thread.kind} · {entry.thread.status}</div>
          </button>
        {/each}
      {/if}
    </aside>

    <div class="thread-detail">
      {#if selectedThread}
        <div class="detail-header">
          <div class="detail-title">{selectedThread.title || selectedThread.id}</div>
          <div class="detail-meta">{selectedThread.kind} · {selectedThread.status}</div>
        </div>
        {#if threadMessages.length === 0}
          <div class="empty">No messages yet.</div>
        {:else}
          <div class="message-list">
            {#each threadMessages as message (message.id)}
              <article class="message-card">
                <div class="message-top">
                  <span class="message-from">{message.from}</span>
                  <span class="message-kind">{message.kind}</span>
                </div>
                <div class="message-body">{message.body}</div>
              </article>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="empty">Select a thread.</div>
      {/if}
    </div>
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

  .thread-layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    flex: 1;
    min-height: 0;
  }

  .thread-list {
    border-right: 1px solid var(--border);
    overflow: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .thread-detail {
    overflow: auto;
    padding: 12px 16px 16px;
  }

  .thread-chip {
    text-align: left;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: rgba(15, 23, 34, 0.6);
    padding: 10px;
  }

  .thread-chip.active {
    background: var(--bg-surface-active);
    border-color: var(--border-active);
  }

  .thread-chip-title,
  .detail-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .thread-chip-meta,
  .detail-meta,
  .message-kind {
    font-size: 11px;
    color: var(--text-dim);
  }

  .detail-header {
    margin-bottom: 12px;
  }

  .message-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .message-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    background: rgba(15, 23, 34, 0.7);
  }

  .message-top {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
  }

  .message-from {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
  }

  .message-body {
    white-space: pre-wrap;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-secondary);
  }

  .empty,
  .error {
    padding: 24px 4px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .error {
    color: var(--red);
  }
</style>
