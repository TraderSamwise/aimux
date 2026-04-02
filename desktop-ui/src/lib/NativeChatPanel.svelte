<script>
  import {
    getState,
    focusTerminalAgent,
    selectInteractionMode,
    sendNativeChatMessage,
    setNativeChatDraft,
  } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  let { visible = false } = $props();

  const state = getState();
  const termInstance = getTerminal();

  let selectedSession = $derived.by(() => {
    if (!state.selectedProject || !state.selectedSessionId) return null;
    return (state.selectedProject.sessions || []).find((session) => session.id === state.selectedSessionId) || null;
  });
  let draft = $derived.by(() => state.nativeChatDraft || "");

  function sessionLabel(session) {
    return session?.label || session?.tool || session?.id || "session";
  }

  async function openInTerminal() {
    const project = state.selectedProject;
    const session = selectedSession;
    if (!project || !session || !termInstance.terminal) return;
    selectInteractionMode("terminal");
    await focusTerminalAgent(termInstance.terminal, project.path, session.id, sessionLabel(session));
  }

  async function submitDraft() {
    await sendNativeChatMessage();
  }

  async function handleComposerKeydown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    await submitDraft();
  }
</script>

<section class="panel" class:hidden={!visible}>
  <div class="panel-header">
    <div>
      <div class="section-label">Native Chat</div>
      {#if selectedSession}
        <div class="session-meta">{sessionLabel(selectedSession)} · {selectedSession.id}</div>
      {:else}
        <div class="session-meta">Select a running session to read and send prompts.</div>
      {/if}
    </div>

    <div class="header-actions">
      <button
        class="header-btn"
        class:active={!state.nativeChatRawMode}
        onclick={() => { state.nativeChatRawMode = false; }}
      >
        Parsed
      </button>
      <button
        class="header-btn"
        class:active={state.nativeChatRawMode}
        onclick={() => { state.nativeChatRawMode = true; }}
      >
        Raw
      </button>
      <button
        class="header-btn primary"
        disabled={!selectedSession}
        onclick={openInTerminal}
      >
        Open in Terminal
      </button>
    </div>
  </div>

  <div class="transcript">
    {#if !state.selectedProject}
      <div class="empty">Select a project to use native chat.</div>
    {:else if !selectedSession}
      <div class="empty">Select a session from the worktree list or status chips.</div>
    {:else if state.nativeChatLoading && !state.nativeChatOutput}
      <div class="empty">Loading transcript…</div>
    {:else if state.nativeChatError}
      <div class="error">{state.nativeChatError}</div>
    {:else if state.nativeChatRawMode}
      <pre class="raw-output">{state.nativeChatOutput || "No output captured yet."}</pre>
    {:else if state.nativeChatBlocks.length > 0}
      <div class="message-list">
        {#each state.nativeChatBlocks as block, index (`${block.type}:${index}`)}
          <article class="message" class:prompt={block.type === "prompt"} class:response={block.type === "response"} class:status={block.type === "status"} class:raw={block.type === "raw"} class:meta={block.type === "meta"}>
            <div class="message-kind">
              {#if block.type === "prompt"}
                You
              {:else if block.type === "response"}
                Agent
              {:else if block.type === "status"}
                Status
              {:else if block.type === "meta"}
                Context
              {:else}
                Raw
              {/if}
            </div>
            <pre class="message-text">{block.text}</pre>
          </article>
        {/each}
      </div>
    {:else}
      <div class="empty">No transcript captured yet.</div>
    {/if}
  </div>

  <div class="composer">
    <textarea
      class="composer-input"
      placeholder={selectedSession ? `Message ${sessionLabel(selectedSession)}…` : "Select a session first…"}
      value={draft}
      disabled={!selectedSession}
      oninput={(event) => setNativeChatDraft(event.currentTarget.value)}
      onkeydown={handleComposerKeydown}
    ></textarea>
    <div class="composer-row">
      <span class="composer-hint">Enter to send, Shift+Enter for newline</span>
      <button
        class="send-btn"
        disabled={!selectedSession || !draft.trim()}
        onclick={submitDraft}
      >
        Send
      </button>
    </div>
  </div>
</section>

<style>
  .panel {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid var(--border);
    background:
      linear-gradient(180deg, rgba(11, 18, 29, 0.98), rgba(9, 14, 24, 0.98)),
      radial-gradient(circle at top right, rgba(56, 189, 248, 0.12), transparent 32%);
  }

  .panel.hidden {
    visibility: hidden;
    pointer-events: none;
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }

  .section-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
  }

  .session-meta {
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .header-btn {
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.14);
    background: rgba(148, 163, 184, 0.06);
    color: var(--text-dim);
    font-size: 11px;
    transition: background 120ms, border-color 120ms, color 120ms;
  }

  .header-btn.active {
    background: rgba(56, 189, 248, 0.12);
    border-color: rgba(125, 211, 252, 0.35);
    color: var(--accent);
  }

  .header-btn.primary {
    color: var(--text);
  }

  .transcript {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px;
  }

  .message-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .message {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 12px 14px;
    background: rgba(255, 255, 255, 0.02);
  }

  .message.prompt {
    background: rgba(56, 189, 248, 0.08);
    border-color: rgba(125, 211, 252, 0.22);
  }

  .message.response {
    background: rgba(52, 211, 153, 0.06);
    border-color: rgba(52, 211, 153, 0.18);
  }

  .message.status {
    background: rgba(251, 191, 36, 0.06);
    border-color: rgba(251, 191, 36, 0.18);
  }

  .message.meta {
    background: rgba(125, 211, 252, 0.05);
    border-color: rgba(125, 211, 252, 0.14);
  }

  .message.raw {
    background: rgba(148, 163, 184, 0.04);
  }

  .message-kind {
    margin-bottom: 8px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
  }

  .message-text,
  .raw-output {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "Iosevka Term", "SF Mono", Menlo, monospace;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text);
    background: transparent;
  }

  .raw-output {
    min-height: 100%;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px 16px;
    border-top: 1px solid var(--border);
    background: rgba(8, 12, 20, 0.9);
  }

  .composer-input {
    min-height: 92px;
    resize: vertical;
    border: 1px solid rgba(125, 211, 252, 0.16);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--text);
    padding: 12px 14px;
    font: inherit;
    line-height: 1.45;
  }

  .composer-input:focus {
    outline: none;
    border-color: rgba(125, 211, 252, 0.45);
  }

  .composer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .composer-hint {
    font-size: 11px;
    color: var(--text-dim);
  }

  .send-btn {
    padding: 8px 14px;
    border-radius: 999px;
    background: linear-gradient(135deg, rgba(56, 189, 248, 0.22), rgba(34, 197, 94, 0.18));
    border: 1px solid rgba(125, 211, 252, 0.25);
    color: var(--text);
    font-size: 12px;
    font-weight: 600;
  }

  .empty,
  .error {
    padding: 18px;
    border: 1px dashed var(--border);
    border-radius: 14px;
    color: var(--text-secondary);
    background: rgba(255, 255, 255, 0.02);
  }

  .error {
    color: var(--red);
    border-style: solid;
    border-color: rgba(251, 113, 133, 0.22);
    background: rgba(251, 113, 133, 0.06);
  }
</style>
