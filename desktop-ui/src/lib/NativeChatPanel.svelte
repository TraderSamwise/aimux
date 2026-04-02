<script>
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { tick } from "svelte";
  import {
    addNativeChatImages,
    getState,
    focusTerminalAgent,
    pickNativeChatImages,
    removeNativeChatDraftPart,
    selectInteractionMode,
    sendNativeChatMessage,
    setNativeChatDraftTextPart,
  } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const conversationScrollMemory = new Map();
  const rawScrollMemory = new Map();

  let { visible = false } = $props();

  const appState = getState();
  const termInstance = getTerminal();
  let rawOutputEl = $state(null);
  let messageListEl = $state(null);
  let lastRawOutput = "";
  let lastRawSessionKey = "";
  let lastConversationSignature = "";
  let lastConversationSessionKey = "";
  let lastAnimatedResponseSessionKey = "";
  let lastRestoredConversationKey = "";
  let lastRestoredRawKey = "";
  let forceConversationStick = false;
  let animatedResponseTextById = $state({});
  const responseAnimationTargets = new Map();
  const responseAnimationTimers = new Map();

  let selectedSession = $derived.by(() => {
    if (!appState.selectedProject || !appState.selectedSessionId) return null;
    return (appState.selectedProject.sessions || []).find((session) => session.id === appState.selectedSessionId) || null;
  });
  let sendPending = $derived.by(() => {
    if (!appState.selectedProjectPath || !appState.selectedSessionId) return false;
    return (appState.inFlightActions || []).some(
      (action) =>
        (action.kind === "agent-send" || action.kind === "agent-attach") &&
        action.projectPath === appState.selectedProjectPath &&
        action.sessionId === appState.selectedSessionId,
    );
  });
  let draftParts = $derived.by(() => appState.nativeChatDraftParts || []);
  let hasDraftContent = $derived.by(() =>
    draftParts.some((part) => (part.type === "image" ? Boolean(part.attachmentId) : String(part.text || "").trim().length > 0)),
  );
  let historyMessages = $derived.by(() => appState.nativeChatHistory || []);
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
  let activeDraftTextPartId = $state(null);
  let selectedProjectServiceEndpoint = $derived.by(() => appState.selectedProject?.serviceEndpoint || null);

  function sessionLabel(session) {
    return session?.label || session?.tool || session?.id || "session";
  }

  function stopResponseAnimation(id) {
    const timer = responseAnimationTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      responseAnimationTimers.delete(id);
    }
  }

  function stopAllResponseAnimations() {
    for (const id of responseAnimationTimers.keys()) {
      stopResponseAnimation(id);
    }
    responseAnimationTargets.clear();
  }

  function setAnimatedResponseText(id, text) {
    if (animatedResponseTextById[id] === text) return;
    animatedResponseTextById = {
      ...animatedResponseTextById,
      [id]: text,
    };
  }

  function scheduleResponseAnimation(id) {
    stopResponseAnimation(id);

    const step = () => {
      const target = responseAnimationTargets.get(id) || "";
      const current = animatedResponseTextById[id] ?? "";
      if (!target.startsWith(current)) {
        setAnimatedResponseText(id, target);
        stopResponseAnimation(id);
        return;
      }

      if (current === target) {
        stopResponseAnimation(id);
        return;
      }

      const remaining = target.length - current.length;
      const chunkSize = Math.min(Math.max(1, Math.ceil(remaining / 12)), 8);
      setAnimatedResponseText(id, target.slice(0, current.length + chunkSize));
      if (current.length + chunkSize < target.length) {
        responseAnimationTimers.set(id, setTimeout(step, 18));
      } else {
        stopResponseAnimation(id);
      }
    };

    responseAnimationTimers.set(id, setTimeout(step, 18));
  }

  function displayedResponseText(entry) {
    return animatedResponseTextById[entry.id] ?? entry.text;
  }

  function sameAnimatedResponseMap(a, b) {
    const aKeys = Object.keys(a || {});
    const bKeys = Object.keys(b || {});
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if ((a?.[key] ?? "") !== (b?.[key] ?? "")) return false;
    }
    return true;
  }

  async function openInTerminal() {
    const project = appState.selectedProject;
    const session = selectedSession;
    if (!project || !session || !termInstance.terminal) return;
    selectInteractionMode("terminal");
    await focusTerminalAgent(termInstance.terminal, project.path, session.id, sessionLabel(session));
  }

  async function submitDraft() {
    forceConversationStick = true;
    void syncConversationScroll(true);
    await sendNativeChatMessage();
  }

  function findLastDraftTextPartId() {
    const lastTextPart = [...draftParts].reverse().find((part) => part.type === "text");
    return lastTextPart?.id || null;
  }

  function getInsertionTextPartId(preferredPartId = null) {
    return preferredPartId || activeDraftTextPartId || findLastDraftTextPartId();
  }

  async function addImages(afterTextPartId = null) {
    await pickNativeChatImages(getInsertionTextPartId(afterTextPartId));
  }

  async function handleDraftTextKeydown(partId, event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await submitDraft();
      return;
    }

    const currentValue = event.currentTarget.value || "";
    const currentIndex = draftParts.findIndex((part) => part.id === partId);
    if (currentIndex === -1 || currentValue.length > 0) return;

    if (event.key === "Backspace") {
      const previousPart = draftParts[currentIndex - 1];
      if (previousPart?.type === "image") {
        event.preventDefault();
        removeNativeChatDraftPart(previousPart.id);
      }
    }

    if (event.key === "Delete") {
      const nextPart = draftParts[currentIndex + 1];
      if (nextPart?.type === "image") {
        event.preventDefault();
        removeNativeChatDraftPart(nextPart.id);
      }
    }
  }

  function imageOrdinal(partId) {
    let ordinal = 0;
    for (const part of draftParts) {
      if (part.type !== "image") continue;
      ordinal += 1;
      if (part.id === partId) {
        return ordinal;
      }
    }
    return ordinal || 1;
  }

  function imagePreviewSrc(imagePart) {
    if (imagePart.previewUrl) return imagePart.previewUrl;
    if (imagePart.path) return convertFileSrc(imagePart.path);
    if (imagePart.contentUrl && selectedProjectServiceEndpoint) {
      return `http://${selectedProjectServiceEndpoint.host}:${selectedProjectServiceEndpoint.port}${imagePart.contentUrl}`;
    }
    return null;
  }

  function messagePromptText(message) {
    if (!Array.isArray(message?.parts)) return "";
    return message.parts
      .map((part, index) => {
        if (part?.type === "text") {
          return String(part.text || "");
        }
        if (part?.type === "image") {
          return `[image #${index + 1}]`;
        }
        return "";
      })
      .join("")
      .trim();
  }

  function normalizePromptText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  let conversationEntries = $derived.by(() => {
    const promptBlocks = conversationBlocks.filter((block) => block.type === "prompt");
    const promptMessageByPromptIndex = new Map();
    const matchedHistoryIndices = new Set();
    let historyIndex = historyMessages.length - 1;
    for (let promptIndex = promptBlocks.length - 1; promptIndex >= 0; promptIndex -= 1) {
      const block = promptBlocks[promptIndex];
      const blockText = normalizePromptText(block?.text);
      let matchedIndex = -1;
      for (let candidateIndex = historyIndex; candidateIndex >= 0; candidateIndex -= 1) {
        const candidateText = normalizePromptText(messagePromptText(historyMessages[candidateIndex]));
        if (!candidateText) continue;
        if (candidateText === blockText || candidateText.includes(blockText) || blockText.includes(candidateText)) {
          matchedIndex = candidateIndex;
          break;
        }
      }
      if (matchedIndex === -1 && historyIndex >= 0) {
        matchedIndex = historyIndex;
      }
      if (matchedIndex === -1) continue;
      promptMessageByPromptIndex.set(promptIndex, historyMessages[matchedIndex]);
      matchedHistoryIndices.add(matchedIndex);
      historyIndex = matchedIndex - 1;
    }
    let promptIndex = 0;
    const entries = conversationBlocks.map((block, index) => {
      if (block.type !== "prompt") {
        return {
          id: `response:${index}`,
          type: "response",
          text: block.text,
        };
      }
      const message = promptMessageByPromptIndex.get(promptIndex) || null;
      promptIndex += 1;
      return {
        id: message?.id || `prompt:${index}`,
        type: "prompt",
        text: block.text,
        parts: Array.isArray(message?.parts) ? message.parts : null,
      };
    });

    const trailingStart =
      matchedHistoryIndices.size > 0 ? Math.max(...matchedHistoryIndices) + 1 : 0;
    const trailingUnmatchedHistory = historyMessages.filter(
      (_, index) => index >= trailingStart && !matchedHistoryIndices.has(index),
    );
    for (const message of trailingUnmatchedHistory) {
      entries.push({
        id: message?.id || `history:${entries.length}`,
        type: "prompt",
        text: messagePromptText(message),
        parts: Array.isArray(message?.parts) ? message.parts : null,
      });
    }

    return entries;
  });

  async function fileToImageInput(file) {
    const contentBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("failed to read image"));
      reader.onload = () => {
        const result = String(reader.result || "");
        resolve(result.includes(",") ? result.split(",")[1] : result);
      };
      reader.readAsDataURL(file);
    });

    return {
      name: file.name || "image",
      mimeType: file.type || "application/octet-stream",
      contentBase64,
      previewUrl: URL.createObjectURL(file),
    };
  }

  async function handleImageFiles(files, afterTextPartId = null) {
    const imageFiles = [...files].filter((file) => file?.type?.startsWith("image/"));
    if (imageFiles.length === 0) return;
    const inputs = await Promise.all(imageFiles.map((file) => fileToImageInput(file)));
    await addNativeChatImages(inputs, getInsertionTextPartId(afterTextPartId));
  }

  function extractImageFiles(itemList) {
    return [...(itemList || [])]
      .filter((item) => item?.type?.startsWith("image/"))
      .map((item) => item.getAsFile?.())
      .filter(Boolean);
  }

  function dedupeImageFiles(files) {
    const seen = new Set();
    const unique = [];
    for (const file of files || []) {
      if (!file) continue;
      const key = `${file.name || ""}:${file.size || 0}:${file.type || ""}:${file.lastModified || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(file);
    }
    return unique;
  }

  async function handleDraftTextPaste(partId, event) {
    const files = dedupeImageFiles([
      ...extractImageFiles(event.clipboardData?.items),
      ...[...(event.clipboardData?.files || [])].filter((file) => file?.type?.startsWith("image/")),
    ]);
    if (files.length === 0) return;
    event.preventDefault();
    activeDraftTextPartId = partId;
    await handleImageFiles(files, partId);
  }

  function handleComposerDragOver(event) {
    const hasImage = [...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith("image/"));
    if (!hasImage) return;
    event.preventDefault();
  }

  async function handleComposerDrop(event) {
    const files = dedupeImageFiles([
      ...extractImageFiles(event.dataTransfer?.items),
      ...[...(event.dataTransfer?.files || [])].filter((file) => file?.type?.startsWith("image/")),
    ]);
    if (files.length === 0) return;
    event.preventDefault();
    await handleImageFiles(files);
  }

  function handleImageTokenKeydown(partId, event) {
    if (event.key !== "Backspace" && event.key !== "Delete" && event.key !== "Enter") return;
    event.preventDefault();
    removeNativeChatDraftPart(partId);
  }

  $effect(() => {
    if (draftParts.some((part) => part.id === activeDraftTextPartId)) return;
    activeDraftTextPartId = findLastDraftTextPartId();
  });

  function rawSessionKey() {
    return `${appState.nativeChatProjectPath || ""}:${appState.nativeChatSessionId || ""}`;
  }

  function conversationScrollKey() {
    return `${rawSessionKey()}:conversation`;
  }

  function rawScrollKey() {
    return `${rawSessionKey()}:raw`;
  }

  function isNearBottom(element, threshold = 48) {
    if (!element) return false;
    return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
  }

  function saveConversationScrollPosition() {
    if (!messageListEl) return;
    conversationScrollMemory.set(conversationScrollKey(), {
      scrollTop: messageListEl.scrollTop,
      stickToBottom: isNearBottom(messageListEl),
    });
  }

  function saveRawScrollPosition() {
    if (!rawOutputEl) return;
    rawScrollMemory.set(rawScrollKey(), {
      scrollTop: rawOutputEl.scrollTop,
      stickToBottom: isNearBottom(rawOutputEl),
    });
  }

  async function restoreConversationScrollPosition() {
    await tick();
    if (!messageListEl) return;
    const saved = conversationScrollMemory.get(conversationScrollKey());
    if (!saved || saved.stickToBottom) {
      messageListEl.scrollTop = messageListEl.scrollHeight;
      return;
    }
    const maxScrollTop = Math.max(0, messageListEl.scrollHeight - messageListEl.clientHeight);
    messageListEl.scrollTop = Math.min(saved.scrollTop, maxScrollTop);
  }

  async function restoreRawScrollPosition() {
    await tick();
    if (!rawOutputEl) return;
    const saved = rawScrollMemory.get(rawScrollKey());
    if (!saved || saved.stickToBottom) {
      rawOutputEl.scrollTop = rawOutputEl.scrollHeight;
      return;
    }
    const maxScrollTop = Math.max(0, rawOutputEl.scrollHeight - rawOutputEl.clientHeight);
    rawOutputEl.scrollTop = Math.min(saved.scrollTop, maxScrollTop);
  }

  async function syncRawScroll(force = false) {
    await tick();
    if (!rawOutputEl) return;
    if (force) {
      rawOutputEl.scrollTop = rawOutputEl.scrollHeight;
    }
  }

  async function syncConversationScroll(force = false) {
    await tick();
    if (!messageListEl) return;
    if (force) {
      messageListEl.scrollTop = messageListEl.scrollHeight;
    }
  }

  $effect(() => {
    const rawMode = appState.nativeChatRawMode;
    const output = appState.nativeChatOutput || "";
    const baseSessionKey = rawSessionKey();
    const scrollKey = rawScrollKey();
    if (!rawMode) {
      lastRawOutput = output;
      lastRawSessionKey = baseSessionKey;
      return;
    }

    const sessionChanged = baseSessionKey !== lastRawSessionKey;
    const outputChanged = output !== lastRawOutput;
    const nearBottomBeforeUpdate = isNearBottom(rawOutputEl);
    const shouldStick = sessionChanged || outputChanged;

    lastRawOutput = output;
    lastRawSessionKey = baseSessionKey;

    if (sessionChanged && lastRestoredRawKey !== scrollKey) {
      lastRestoredRawKey = scrollKey;
      void restoreRawScrollPosition();
      return;
    }

    if (shouldStick && nearBottomBeforeUpdate) {
      void syncRawScroll(true);
    }
  });

  $effect(() => {
    const rawMode = appState.nativeChatRawMode;
    const baseSessionKey = rawSessionKey();
    const scrollKey = conversationScrollKey();
    const signature = (conversationBlocks || [])
      .map((block) => `${block.type}:${block.text}`)
      .join("\n---\n");

    if (rawMode) {
      lastConversationSignature = signature;
      lastConversationSessionKey = baseSessionKey;
      return;
    }

    const sessionChanged = baseSessionKey !== lastConversationSessionKey;
    const contentChanged = signature !== lastConversationSignature;
    const nearBottomBeforeUpdate = isNearBottom(messageListEl);
    const shouldForceStick = forceConversationStick;

    lastConversationSignature = signature;
    lastConversationSessionKey = baseSessionKey;

    if (sessionChanged && lastRestoredConversationKey !== scrollKey) {
      lastRestoredConversationKey = scrollKey;
      forceConversationStick = false;
      void restoreConversationScrollPosition();
      return;
    }

    if (contentChanged && (shouldForceStick || nearBottomBeforeUpdate)) {
      forceConversationStick = false;
      void syncConversationScroll(true);
    }
  });

  $effect(() => {
    const sessionKey = rawSessionKey();
    const entries = conversationEntries || [];
    const responseEntries = entries.filter((entry) => entry.type === "response");
    const responseIds = new Set(responseEntries.map((entry) => entry.id));

    if (sessionKey !== lastAnimatedResponseSessionKey) {
      lastAnimatedResponseSessionKey = sessionKey;
      stopAllResponseAnimations();
      animatedResponseTextById = Object.fromEntries(responseEntries.map((entry) => [entry.id, entry.text]));
      for (const entry of responseEntries) {
        responseAnimationTargets.set(entry.id, entry.text);
      }
      return;
    }

    const currentAnimated = animatedResponseTextById;
    const nextAnimated = {};
    for (const entry of responseEntries) {
      nextAnimated[entry.id] = currentAnimated[entry.id] ?? entry.text;
    }
    for (const existingId of Object.keys(currentAnimated)) {
      if (!responseIds.has(existingId)) {
        stopResponseAnimation(existingId);
        responseAnimationTargets.delete(existingId);
      }
    }
    if (!sameAnimatedResponseMap(currentAnimated, nextAnimated)) {
      animatedResponseTextById = nextAnimated;
    }

    const activeResponseId = responseEntries.length > 0 ? responseEntries[responseEntries.length - 1].id : null;
    for (const entry of responseEntries) {
      const previousTarget = responseAnimationTargets.get(entry.id);
      const displayed = nextAnimated[entry.id] ?? "";
      responseAnimationTargets.set(entry.id, entry.text);

      if (previousTarget == null) {
        setAnimatedResponseText(entry.id, entry.text);
        continue;
      }

      if (entry.text === displayed) {
        stopResponseAnimation(entry.id);
        continue;
      }

      const isAppend = entry.text.startsWith(displayed) && entry.text.length > displayed.length;
      if (entry.id === activeResponseId && isAppend) {
        scheduleResponseAnimation(entry.id);
      } else {
        stopResponseAnimation(entry.id);
        setAnimatedResponseText(entry.id, entry.text);
      }
    }
  });

  $effect(() => {
    const scrollKey = conversationScrollKey();
    if (appState.nativeChatRawMode || !messageListEl || !selectedSession) return;
    if (lastRestoredConversationKey === scrollKey) return;
    lastRestoredConversationKey = scrollKey;
    void restoreConversationScrollPosition();
  });

  $effect(() => {
    const scrollKey = rawScrollKey();
    if (!appState.nativeChatRawMode || !rawOutputEl || !selectedSession) return;
    if (lastRestoredRawKey === scrollKey) return;
    lastRestoredRawKey = scrollKey;
    void restoreRawScrollPosition();
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
        <pre class="raw-output" bind:this={rawOutputEl} onscroll={saveRawScrollPosition}>{appState.nativeChatOutput || "No output captured yet."}</pre>
      </div>
    {:else if appState.nativeChatBlocks.length > 0}
      <div class="split-layout">
        <div class="chat-pane">
          <div class="pane-title">Conversation</div>
          {#if conversationBlocks.length > 0}
            <div class="message-list" bind:this={messageListEl} onscroll={saveConversationScrollPosition}>
              {#each conversationEntries as entry (`${entry.id}`)}
                <article class="turn" class:prompt-turn={entry.type === "prompt"} class:response-turn={entry.type === "response"}>
                  <article class="message" class:prompt={entry.type === "prompt"} class:response={entry.type === "response"}>
                  <div class="message-kind">
                    {#if entry.type === "prompt"}
                      You
                    {:else}
                      Agent
                    {/if}
                  </div>
                  {#if entry.type === "prompt" && entry.parts}
                    <div class="message-parts">
                      {#each entry.parts as part, partIndex (`${entry.id}:part:${partIndex}`)}
                        {#if part.type === "text"}
                          <pre class="message-text">{part.text}</pre>
                        {:else}
                          <div class="history-image">
                            <div class="history-image-token">[image #{partIndex + 1}]</div>
                            {#if imagePreviewSrc(part)}
                              <img class="history-image-thumb" src={imagePreviewSrc(part)} alt={part.alt || part.filename || "image"} />
                            {/if}
                            <div class="history-image-label">{part.alt || part.filename || "image"}</div>
                          </div>
                        {/if}
                      {/each}
                    </div>
                  {:else}
                    <pre class="message-text">{entry.type === "response" ? displayedResponseText(entry) : entry.text}</pre>
                  {/if}
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

  <div class="composer" role="group" aria-label="Native chat composer" ondragover={handleComposerDragOver} ondrop={handleComposerDrop}>
    <div class="composer-flow">
      {#each draftParts as part, index (part.id)}
        {#if part.type === "text"}
          <textarea
            class="composer-input"
            class:composer-input-compact={index > 0}
            placeholder={selectedSession
              ? (index === 0 ? `Message ${sessionLabel(selectedSession)}…` : "Continue message…")
              : "Select a session first…"}
            value={part.text}
            disabled={!selectedSession}
            onfocus={() => { activeDraftTextPartId = part.id; }}
            oninput={(event) => setNativeChatDraftTextPart(part.id, event.currentTarget.value)}
            onkeydown={(event) => handleDraftTextKeydown(part.id, event)}
            onpaste={(event) => handleDraftTextPaste(part.id, event)}
          ></textarea>
        {:else}
          <div class="draft-image-block">
            <button
              type="button"
              class="inline-image-token"
              onclick={() => { activeDraftTextPartId = findLastDraftTextPartId(); }}
              onkeydown={(event) => handleImageTokenKeydown(part.id, event)}
            >
              [image #{imageOrdinal(part.id)}]
            </button>
            <div class="draft-image-preview">
              <div class="draft-image-meta">
                <div class="draft-image-name">{part.name}</div>
                <div class="draft-image-path">{part.path || part.attachmentId}</div>
              </div>
              {#if imagePreviewSrc(part)}
                <img class="draft-image-thumb" src={imagePreviewSrc(part)} alt={part.name} />
              {:else}
                <div class="draft-image-placeholder">Preview unavailable</div>
              {/if}
              <button type="button" class="draft-image-remove" onclick={() => removeNativeChatDraftPart(part.id)}>
                Remove
              </button>
            </div>
          </div>
        {/if}
      {/each}
    </div>
    {#if appState.nativeChatComposerError}
      <div class="composer-error">{appState.nativeChatComposerError}</div>
    {/if}
    <div class="composer-row">
      <span class="composer-hint">Enter to send, Shift+Enter for newline. Paste or drop images inline.</span>
      <button
        class="attach-btn"
        disabled={!selectedSession || sendPending}
        onclick={() => addImages()}
      >
        Add Image
      </button>
      {#if sendPending}
        <span class="composer-status">Sending…</span>
      {/if}
      <button
        class="send-btn"
        disabled={!selectedSession || !hasDraftContent || sendPending}
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

  .message-parts {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .history-image {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }

  .history-image-token {
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.12);
    border: 1px solid rgba(125, 211, 252, 0.2);
    color: var(--accent);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .history-image-thumb {
    width: min(280px, 100%);
    max-height: 220px;
    object-fit: cover;
    border-radius: 12px;
    border: 1px solid rgba(148, 163, 184, 0.16);
    background: rgba(255, 255, 255, 0.04);
  }

  .history-image-label {
    font-size: 11px;
    color: var(--text-dim);
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

  .composer-flow {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .composer-input {
    min-height: 84px;
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

  .composer-input-compact {
    min-height: 64px;
  }

  .draft-image-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .inline-image-token {
    align-self: flex-start;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.12);
    border: 1px solid rgba(125, 211, 252, 0.2);
    color: var(--accent);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .inline-image-token:focus {
    outline: none;
    border-color: rgba(125, 211, 252, 0.45);
  }

  .draft-image-preview {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    border: 1px solid rgba(125, 211, 252, 0.14);
    border-radius: 12px;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.03);
  }

  .draft-image-meta {
    min-width: 0;
  }

  .draft-image-name {
    font-size: 12px;
    color: var(--text);
  }

  .draft-image-path {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 360px;
  }

  .draft-image-thumb,
  .draft-image-placeholder {
    width: 84px;
    height: 84px;
    border-radius: 10px;
    border: 1px solid rgba(148, 163, 184, 0.16);
    background: rgba(255, 255, 255, 0.04);
    object-fit: cover;
    flex-shrink: 0;
  }

  .draft-image-placeholder {
    display: grid;
    place-items: center;
    padding: 8px;
    font-size: 11px;
    color: var(--text-dim);
    text-align: center;
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

  .composer-error {
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid rgba(251, 113, 133, 0.24);
    background: rgba(251, 113, 133, 0.08);
    color: var(--red);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .attach-btn,
  .draft-image-remove {
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.08);
    border: 1px solid rgba(148, 163, 184, 0.16);
    color: var(--text-secondary);
    font-size: 11px;
    flex-shrink: 0;
  }

  .draft-image-remove {
    margin-left: auto;
    align-self: center;
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
