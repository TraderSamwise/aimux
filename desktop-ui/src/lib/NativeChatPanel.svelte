<script>
  import { tick } from "svelte";
  import {
    getState,
    focusTerminalAgent,
    selectInteractionMode,
    sendNativeChatMessage,
    setNativeChatDraft,
  } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  let { visible = false } = $props();

  const appState = getState();
  const termInstance = getTerminal();
  let rawOutputEl = $state(null);
  let lastRawOutput = "";
  let lastRawSessionKey = "";

  let selectedSession = $derived.by(() => {
    if (!appState.selectedProject || !appState.selectedSessionId) return null;
    return (appState.selectedProject.sessions || []).find((session) => session.id === appState.selectedSessionId) || null;
  });
  let sendPending = $derived.by(() => {
    if (!appState.selectedProjectPath || !appState.selectedSessionId) return false;
    return (appState.inFlightActions || []).some(
      (action) =>
        action.kind === "agent-send" &&
        action.projectPath === appState.selectedProjectPath &&
        action.sessionId === appState.selectedSessionId,
    );
  });
  let draft = $derived.by(() => appState.nativeChatDraft || "");
  let conversationBlocks = $derived.by(() =>
    (appState.nativeChatBlocks || []).filter((block) => block.type === "prompt" || block.type === "response"),
  );
  let sideBlocks = $derived.by(() =>
    (appState.nativeChatBlocks || []).filter(
      (block) => block.type === "status" || block.type === "meta" || block.type === "raw",
    ),
  );
  let collapsedSideBlocks = $derived.by(() => {
    const next = [];
    const normalizedSeen = new Set();

    for (const block of sideBlocks || []) {
      const normalized = String(block.text || "").replace(/\s+/g, " ").trim();
      if (!normalized) continue;

      if (block.type === "raw") {
        if (next.length === 0 || next[next.length - 1].type !== "raw") {
          next.push({ ...block, text: normalized });
        }
        continue;
      }

      const key = `${block.type}:${normalized}`;
      if (normalizedSeen.has(key)) continue;
      normalizedSeen.add(key);
      next.push(block);
    }

    const statusBlocks = next.filter((block) => block.type === "status");
    const metaBlocks = next.filter((block) => block.type === "meta");
    const rawBlocks = next.filter((block) => block.type === "raw");

    return [
      ...metaBlocks.slice(-2),
      ...statusBlocks.slice(-3),
      ...rawBlocks.slice(-1),
    ];
  });

  function sessionLabel(session) {
    return session?.label || session?.tool || session?.id || "session";
  }

  async function openInTerminal() {
    const project = appState.selectedProject;
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

  function rawSessionKey() {
    return `${appState.nativeChatProjectPath || ""}:${appState.nativeChatSessionId || ""}`;
  }

  function isNearBottom(element, threshold = 28) {
    if (!element) return false;
    return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
  }

  async function syncRawScroll(force = false) {
    await tick();
    if (!rawOutputEl) return;
    if (force) {
      rawOutputEl.scrollTop = rawOutputEl.scrollHeight;
    }
  }

  $effect(() => {
    const rawMode = appState.nativeChatRawMode;
    const output = appState.nativeChatOutput || "";
    const sessionKey = rawSessionKey();
    if (!rawMode) {
      lastRawOutput = output;
      lastRawSessionKey = sessionKey;
      return;
    }

    const sessionChanged = sessionKey !== lastRawSessionKey;
    const outputChanged = output !== lastRawOutput;
    const nearBottomBeforeUpdate = isNearBottom(rawOutputEl);
    const shouldStick = sessionChanged || outputChanged;

    lastRawOutput = output;
    lastRawSessionKey = sessionKey;

    if (shouldStick && (sessionChanged || nearBottomBeforeUpdate)) {
      void syncRawScroll(true);
    }
  });
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
        class:active={appState.nativeChatRawMode}
        onclick={() => { appState.nativeChatRawMode = true; }}
      >
        Raw Pane
      </button>
      <button
        class="header-btn"
        class:active={!appState.nativeChatRawMode}
        onclick={() => { appState.nativeChatRawMode = false; }}
      >
        Split View
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
    {#if !appState.selectedProject}
      <div class="empty">Select a project to use native chat.</div>
    {:else if !selectedSession}
      <div class="empty">Select a session from the worktree list or status chips.</div>
    {:else if appState.nativeChatLoading && !appState.nativeChatOutput}
      <div class="empty">Loading transcript…</div>
    {:else if appState.nativeChatError}
      <div class="error">{appState.nativeChatError}</div>
    {:else if appState.nativeChatRawMode}
      <div class="raw-shell">
        <div class="rail-title">Raw Pane</div>
        <pre class="raw-output" bind:this={rawOutputEl}>{appState.nativeChatOutput || "No output captured yet."}</pre>
      </div>
    {:else if appState.nativeChatBlocks.length > 0}
      <div class="split-layout">
        <div class="chat-pane">
          <div class="pane-title">Conversation</div>
          {#if conversationBlocks.length > 0}
            <div class="message-list">
              {#each conversationBlocks as block, index (`${block.type}:${index}`)}
                <article class="turn" class:prompt-turn={block.type === "prompt"} class:response-turn={block.type === "response"}>
                  <article class="message" class:prompt={block.type === "prompt"} class:response={block.type === "response"}>
                  <div class="message-kind">
                    {#if block.type === "prompt"}
                      You
                    {:else}
                      Agent
                    {/if}
                  </div>
                  <pre class="message-text">{block.text}</pre>
                  </article>
                </article>
              {/each}
            </div>
          {:else}
            <div class="empty-inline">No parsed conversation turns yet.</div>
          {/if}
        </div>

        <aside class="side-pane">
          <div class="pane-title">Context</div>
          {#if collapsedSideBlocks.length > 0}
            <div class="side-list">
              {#each collapsedSideBlocks as block, index (`side:${block.type}:${index}`)}
                <article class="message" class:status={block.type === "status"} class:raw={block.type === "raw"} class:meta={block.type === "meta"}>
                  <div class="message-kind">
                    {#if block.type === "status"}
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
            <div class="empty-inline">No extra context blocks.</div>
          {/if}
        </aside>
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
      {#if sendPending}
        <span class="composer-status">Sending…</span>
      {/if}
      <button
        class="send-btn"
        disabled={!selectedSession || !draft.trim() || sendPending}
        onclick={submitDraft}
      >
        {sendPending ? "Sending…" : "Send"}
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
    padding: 16px;
    overflow: hidden;
  }

  .split-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.8fr);
    gap: 14px;
    height: 100%;
    min-height: 0;
  }

  .chat-pane,
  .side-pane,
  .raw-shell {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .chat-pane,
  .side-pane {
    overflow: hidden;
    position: relative;
  }

  .pane-title,
  .rail-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    padding: 0 2px;
  }

  .side-pane .pane-title,
  .raw-shell .rail-title {
    position: sticky;
    top: 0;
    z-index: 1;
    background: linear-gradient(180deg, rgba(11, 18, 29, 0.98), rgba(11, 18, 29, 0.88));
    padding: 6px 2px 8px;
    margin: -6px 0 0;
  }

  .message-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: auto;
    min-height: 0;
    padding-right: 4px;
  }

  .turn {
    display: flex;
    width: 100%;
  }

  .turn.prompt-turn {
    justify-content: flex-end;
  }

  .turn.response-turn {
    justify-content: flex-start;
  }

  .side-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow: auto;
    min-height: 0;
    padding: 0 4px 0 0;
  }

  .message {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 12px 14px;
    background: rgba(255, 255, 255, 0.02);
  }

  .message.prompt {
    width: min(72%, 540px);
    background: linear-gradient(135deg, rgba(56, 189, 248, 0.14), rgba(56, 189, 248, 0.08));
    border-color: rgba(125, 211, 252, 0.32);
    box-shadow: inset 0 1px 0 rgba(125, 211, 252, 0.08);
  }

  .message.response {
    width: min(88%, 820px);
    background: rgba(52, 211, 153, 0.05);
    border-color: rgba(52, 211, 153, 0.16);
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
    opacity: 0.88;
  }

  .message-kind {
    margin-bottom: 8px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
  }

  .message.prompt .message-kind {
    color: var(--accent);
  }

  .message.response .message-kind {
    color: rgba(52, 211, 153, 0.9);
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
    min-height: 0;
    flex: 1;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 14px;
    background: rgba(148, 163, 184, 0.04);
  }

  .empty-inline {
    padding: 14px;
    border: 1px dashed var(--border);
    border-radius: 12px;
    color: var(--text-dim);
    background: rgba(255, 255, 255, 0.02);
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
    justify-content: flex-end;
    gap: 12px;
  }

  .composer-hint {
    font-size: 11px;
    color: var(--text-dim);
    margin-right: auto;
  }

  .composer-status {
    font-size: 11px;
    color: var(--accent);
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

  @media (max-width: 1100px) {
    .split-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
