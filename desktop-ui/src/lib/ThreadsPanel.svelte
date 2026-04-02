<script>
  import { invoke } from "@tauri-apps/api/core";
  import { getState, trackAction } from "../stores/state.svelte.js";

  let { visible = false } = $props();

  const appState = getState();

  let loading = $state(false);
  let error = $state(null);
  let threads = $state([]);
  let selectedThreadId = $state(null);
  let selectedThread = $state(null);
  let threadMessages = $state([]);

  let composeMode = $state("message");
  let composeBody = $state("");
  let composeTitle = $state("");
  let composeRecipients = $state("");
  let composeAssignee = $state("");
  let composeTool = $state("");
  let composeKind = $state("request");
  let threadReply = $state("");

  function recipientsArray(raw) {
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async function loadThreads() {
    const project = appState.selectedProject;
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
      threads = Array.isArray(result) ? result : [];
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
    const project = appState.selectedProject;
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

  async function refreshAll(preferredThreadId = null) {
    await loadThreads();
    if (preferredThreadId) {
      selectedThreadId = preferredThreadId;
    }
    await loadThreadDetail();
  }

  async function sendCompose() {
    const project = appState.selectedProject;
    if (!project || !composeBody.trim()) return;
    const body = composeBody.trim();
    const recipients = recipientsArray(composeRecipients);
    const currentMode = composeMode;

    try {
      const result = await trackAction(
        {
          kind: currentMode === "task" ? "task-assign" : currentMode === "handoff" ? "handoff-send" : "thread-send",
          message:
            currentMode === "task"
              ? "Assigning task..."
              : currentMode === "handoff"
                ? "Sending handoff..."
                : "Sending message...",
          projectPath: project.path,
        },
        () => {
          if (currentMode === "task") {
            return invoke("task_assign", {
              projectPath: project.path,
              description: body,
              to: recipients[0] || null,
              assignee: composeAssignee.trim() || null,
              tool: composeTool.trim() || null,
              prompt: null,
              kind: "task",
              diff: null,
              worktreePath: null,
              from: "user",
            });
          }
          if (currentMode === "handoff") {
            return invoke("handoff_send", {
              projectPath: project.path,
              body,
              to: recipients.length > 0 ? recipients : null,
              assignee: composeAssignee.trim() || null,
              tool: composeTool.trim() || null,
              worktreePath: null,
              from: "user",
              title: composeTitle.trim() || null,
            });
          }
          return invoke("thread_send", {
            projectPath: project.path,
            threadId: null,
            from: "user",
            to: recipients.length > 0 ? recipients : null,
            assignee: composeAssignee.trim() || null,
            tool: composeTool.trim() || null,
            worktreePath: null,
            kind: composeKind,
            body,
            title: composeTitle.trim() || null,
          });
        },
      );

      composeBody = "";
      composeTitle = "";
      composeRecipients = "";
      composeAssignee = "";
      composeTool = "";
      await refreshAll(result?.thread?.id || null);
    } catch (err) {
      error = String(err);
    }
  }

  async function sendReply() {
    const project = appState.selectedProject;
    if (!project || !selectedThreadId || !threadReply.trim()) return;
    const body = threadReply.trim();
    try {
      await trackAction(
        {
          kind: "thread-reply",
          message: "Sending reply...",
          projectPath: project.path,
        },
        () =>
          invoke("thread_send", {
            projectPath: project.path,
            threadId: selectedThreadId,
            from: "user",
            to: null,
            assignee: null,
            tool: null,
            worktreePath: null,
            kind: "reply",
            body,
            title: null,
          }),
      );
      threadReply = "";
      await loadThreadDetail();
      await loadThreads();
    } catch (err) {
      error = String(err);
    }
  }

  async function updateThreadStatus(status) {
    const project = appState.selectedProject;
    if (!project || !selectedThreadId) return;
    try {
      await trackAction(
        {
          kind: "thread-status",
          message: `Marking thread ${status}...`,
          projectPath: project.path,
        },
        () =>
          invoke("thread_status", {
            projectPath: project.path,
            threadId: selectedThreadId,
            status,
            owner: null,
            waitingOn: null,
          }),
      );
      await refreshAll(selectedThreadId);
    } catch (err) {
      error = String(err);
    }
  }

  async function acceptHandoff() {
    const project = appState.selectedProject;
    if (!project || !selectedThreadId) return;
    try {
      await trackAction(
        { kind: "handoff-accept", message: "Accepting handoff...", projectPath: project.path },
        () => invoke("handoff_accept", { projectPath: project.path, threadId: selectedThreadId, from: "user", body: null }),
      );
      await refreshAll(selectedThreadId);
    } catch (err) {
      error = String(err);
    }
  }

  async function completeHandoff() {
    const project = appState.selectedProject;
    if (!project || !selectedThreadId) return;
    try {
      await trackAction(
        { kind: "handoff-complete", message: "Completing handoff...", projectPath: project.path },
        () => invoke("handoff_complete", { projectPath: project.path, threadId: selectedThreadId, from: "user", body: null }),
      );
      await refreshAll(selectedThreadId);
    } catch (err) {
      error = String(err);
    }
  }

  $effect(() => {
    appState.selectedProject?.path;
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

  <div class="compose-bar">
    <div class="mode-row">
      {#each ["message", "handoff", "task"] as mode}
        <button class="mode-chip" class:active={composeMode === mode} onclick={() => { composeMode = mode; }}>
          {mode}
        </button>
      {/each}
    </div>
    <input class="text-input" bind:value={composeTitle} placeholder="optional title..." />
    <textarea class="body-input" bind:value={composeBody} placeholder={composeMode === "task" ? "task description..." : composeMode === "handoff" ? "handoff details..." : "message body..."}></textarea>
    <div class="compose-meta">
      <input class="text-input" bind:value={composeRecipients} placeholder="to: session1,session2" />
      <input class="text-input" bind:value={composeAssignee} placeholder="assignee role" />
      <input class="text-input" bind:value={composeTool} placeholder="tool key" />
      {#if composeMode === "message"}
        <select class="text-input select" bind:value={composeKind}>
          <option value="request">request</option>
          <option value="reply">reply</option>
          <option value="status">status</option>
          <option value="decision">decision</option>
          <option value="note">note</option>
        </select>
      {/if}
      <button class="primary-btn" onclick={sendCompose} disabled={!composeBody.trim()}>
        {composeMode === "task" ? "assign" : composeMode === "handoff" ? "handoff" : "send"}
      </button>
    </div>
  </div>

  <div class="thread-layout">
    <aside class="thread-list">
      {#if !appState.selectedProject}
        <div class="empty">Select a project to view threads.</div>
      {:else if loading && threads.length === 0}
        <div class="empty">Loading threads…</div>
      {:else if error}
        <div class="error">{error}</div>
      {:else if threads.length === 0}
        <div class="empty">No threads yet.</div>
      {:else}
        {#each threads as entry (entry.thread.id)}
          <button class="thread-chip" class:active={selectedThreadId === entry.thread.id} onclick={() => { selectedThreadId = entry.thread.id; }}>
            <div class="thread-chip-title">{entry.thread.title || entry.thread.id}</div>
            <div class="thread-chip-meta">{entry.thread.kind} · {entry.thread.status}</div>
          </button>
        {/each}
      {/if}
    </aside>

    <div class="thread-detail">
      {#if selectedThread}
        <div class="detail-header">
          <div>
            <div class="detail-title">{selectedThread.title || selectedThread.id}</div>
            <div class="detail-meta">{selectedThread.kind} · {selectedThread.status}</div>
          </div>
          <div class="detail-actions">
            {#each ["open", "waiting", "blocked", "done"] as status}
              <button class="inline-chip" class:selected={selectedThread.status === status} onclick={() => updateThreadStatus(status)}>
                {status}
              </button>
            {/each}
            {#if selectedThread.kind === "handoff"}
              <button class="inline-chip confirm" onclick={acceptHandoff}>accept</button>
              <button class="inline-chip confirm" onclick={completeHandoff}>complete</button>
            {/if}
          </div>
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
        <div class="reply-box">
          <textarea class="body-input compact" bind:value={threadReply} placeholder="reply to this thread..."></textarea>
          <button class="primary-btn" onclick={sendReply} disabled={!threadReply.trim()}>reply</button>
        </div>
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

  .compose-bar {
    border-bottom: 1px solid var(--border);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: rgba(12, 18, 28, 0.55);
  }

  .mode-row,
  .compose-meta,
  .detail-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .mode-chip,
  .inline-chip,
  .primary-btn {
    padding: 4px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: 11px;
  }

  .mode-chip.active,
  .inline-chip.selected,
  .primary-btn,
  .inline-chip.confirm {
    background: rgba(56, 189, 248, 0.1);
    border-color: rgba(125, 211, 252, 0.25);
    color: var(--accent);
  }

  .text-input,
  .body-input {
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: rgba(15, 23, 34, 0.8);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .select {
    width: auto;
  }

  .body-input {
    min-height: 74px;
    resize: vertical;
  }

  .body-input.compact {
    min-height: 56px;
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
    display: flex;
    justify-content: space-between;
    gap: 12px;
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

  .reply-box {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
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
