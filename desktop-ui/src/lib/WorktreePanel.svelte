<script>
  import { invoke } from "@tauri-apps/api/core";
  import { getState, selectSession, runTerminal, isActionPending, trackAction } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const appState = getState();
  const termInstance = getTerminal();

  let showNewWorktreeInput = $state(false);
  let newWorktreeName = $state("");
  let showSpawnMenu = $state(null);
  let errorMsg = $state(null);

  // Group sessions by worktree.
  // Base session list comes from daemon (includes offline/stopped).
  // Statusline provides enrichment (label, role, headline, metadata).
  let worktrees = $derived.by(() => {
    const daemonSessions = appState.daemonSessions;
    const sl = appState.statusline;
    const slSessions = sl?.sessions ?? [];
    const meta = sl?.metadata ?? {};
    const listedWorktrees = appState.worktreeList ?? [];
    const pendingActions = (appState.inFlightActions ?? []).filter(
      (action) => action.projectPath === appState.selectedProject?.path,
    );

    // Build a lookup from statusline sessions for enrichment
    const slById = new Map(slSessions.map((s) => [s.id, s]));

    const groups = new Map();
    const orderedKeys = [];

    function ensureGroup(key, build) {
      if (!groups.has(key)) {
        groups.set(key, build());
        orderedKeys.push(key);
      }
      return groups.get(key);
    }

    for (const wt of listedWorktrees) {
      ensureGroup(wt.path, () => ({ path: wt.path, name: wt.name, branch: wt.branch, agents: [] }));
    }

    for (const s of daemonSessions) {
      const slData = slById.get(s.id);
      const m = meta[s.id];
      const ctx = m?.context;
      const wtPath = s.worktreePath || slData?.worktreePath || ctx?.worktreePath || null;
      const wtName = ctx?.worktreeName || (wtPath ? wtPath.split("/").pop() : null);
      const branch = ctx?.branch || null;
      const key = wtPath || "__unassigned__";

      const group = ensureGroup(key, () => ({ path: wtPath, name: wtName || "Unassigned", branch, agents: [] }));
      if (branch && !group.branch) group.branch = branch;
      if (wtName && (!group.name || group.name === "Unassigned")) group.name = wtName;

      // Merge daemon + statusline + metadata
      group.agents.push({
        ...s,
        ...(slData || {}),
        meta: m || null,
        derived: m?.derived || null,
      });
    }

    for (const action of pendingActions) {
      if (action.kind === "spawn") {
        const wtPath = action.worktreePath || null;
        const key = wtPath || "__unassigned__";
        const listed = wtPath ? listedWorktrees.find((wt) => wt.path === wtPath) : null;
        const group = ensureGroup(key, () => ({
          path: wtPath,
          name: listed?.name || (wtPath ? wtPath.split("/").pop() : "Unassigned"),
          branch: listed?.branch || null,
          agents: [],
        }));
        group.agents.unshift({
          id: `pending-spawn:${action.key}`,
          tool: action.tool,
          label: action.tool,
          status: "starting",
          pending: true,
          worktreePath: wtPath,
        });
      }
      if (action.kind === "create-worktree") {
        const key = `pending-worktree:${action.key}`;
        ensureGroup(key, () => ({
          path: null,
          name: action.worktreeName,
          branch: "creating",
          agents: [],
          pending: true,
        }));
      }
    }

    const result = orderedKeys.map((key) => groups.get(key));

    return result.sort((a, b) => {
      if (Boolean(a.pending) !== Boolean(b.pending)) return a.pending ? 1 : -1;
      const aUnassigned = a.path === null;
      const bUnassigned = b.path === null;
      if (aUnassigned !== bUnassigned) return aUnassigned ? 1 : -1;
      return 0;
    });
  });

  function statusDot(agent) {
    if (agent.derived?.attention === "error") return "var(--red)";
    if (agent.derived?.attention === "needs_input") return "var(--yellow)";
    if (agent.derived?.attention === "blocked") return "var(--red)";
    if (agent.derived?.activity === "running") return "var(--green)";
    if (agent.derived?.activity === "done") return "var(--green)";
    if (agent.derived?.activity === "waiting") return "var(--yellow)";
    if (agent.status === "running") return "var(--green)";
    return "var(--text-dim)";
  }

  function agentLabel(agent) {
    return agent.label || agent.tool || agent.id;
  }

  function agentStatusLabel(agent) {
    if (agent.pending && agent.status === "starting") return "starting";
    return agent.status || "idle";
  }

  function showError(raw) {
    // Extract clean error from verbose debug output
    const str = String(raw);
    // Look for stderr= section and get the last meaningful line
    const stderrMatch = str.match(/stderr="([\s\S]+?)"/);
    if (stderrMatch) {
      const lines = stderrMatch[1].split(/\\n|\n/).map((l) => l.trim()).filter(Boolean);
      // Take the last non-empty line (usually the actual error)
      errorMsg = lines[lines.length - 1] || lines[0] || str.slice(0, 150);
    } else {
      errorMsg = str.length > 150 ? str.slice(0, 150) + "..." : str;
    }
    setTimeout(() => { if (errorMsg) errorMsg = null; }, 5000);
  }

  async function focusAgent(agent) {
    selectSession(agent.id);
    const project = appState.selectedProject;
    if (!project || !termInstance.terminal) return;
    await runTerminal(
      termInstance.terminal,
      project.path,
      ["desktop", "focus", "--project", project.path, "--session", agent.id],
      agentLabel(agent),
    );
  }

  async function killAgent(e, agent) {
    e.stopPropagation();
    const project = appState.selectedProject;
    if (!project || isAgentActionPending(agent.id)) return;
    try {
      await trackAction(
        {
          kind: "kill",
          message: `Killing ${agentLabel(agent)}...`,
          projectPath: project.path,
          sessionId: agent.id,
        },
        () => invoke("agent_kill", { projectPath: project.path, sessionId: agent.id }),
      );
    } catch (err) {
      showError(`Kill failed: ${err}`);
    }
  }

  async function stopAgent(e, agent) {
    e.stopPropagation();
    const project = appState.selectedProject;
    if (!project || isAgentActionPending(agent.id)) return;
    try {
      await trackAction(
        {
          kind: "stop",
          message: `Stopping ${agentLabel(agent)}...`,
          projectPath: project.path,
          sessionId: agent.id,
        },
        () => invoke("agent_stop", { projectPath: project.path, sessionId: agent.id }),
      );
    } catch (err) {
      showError(`Stop failed: ${err}`);
    }
  }

  async function spawnAgent(tool, worktreePath) {
    const project = appState.selectedProject;
    if (!project || isSpawnPending(tool, worktreePath)) return;
    showSpawnMenu = null;
    try {
      await trackAction(
        {
          kind: "spawn",
          message: `Spawning ${tool}...`,
          projectPath: project.path,
          tool,
          worktreePath: worktreePath || null,
        },
        () =>
          invoke("agent_spawn", {
            projectPath: project.path,
            tool,
            worktree: worktreePath || null,
          }),
      );
    } catch (err) {
      showError(`Spawn failed: ${err}`);
    }
  }

  async function createWorktree() {
    const project = appState.selectedProject;
    const name = newWorktreeName.trim();
    if (!project || !name || isCreateWorktreePending()) return;
    try {
      await trackAction(
        {
          kind: "create-worktree",
          message: `Creating worktree "${name}"...`,
          projectPath: project.path,
          worktreeName: name,
        },
        () => invoke("worktree_create", { projectPath: project.path, name }),
      );
      newWorktreeName = "";
      showNewWorktreeInput = false;
    } catch (err) {
      showError(`Worktree create failed: ${err}`);
    }
  }

  function isAgentActionPending(sessionId) {
    return isActionPending({ projectPath: appState.selectedProject?.path, sessionId });
  }

  function isSpawnPending(tool, worktreePath) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "spawn",
      tool,
      worktreePath: worktreePath || null,
    });
  }

  function isCreateWorktreePending() {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "create-worktree",
    });
  }

  function handleWorktreeKeydown(e) {
    if (e.key === "Enter") createWorktree();
    if (e.key === "Escape") { showNewWorktreeInput = false; newWorktreeName = ""; }
  }

  const tools = ["claude", "codex"];
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Worktrees</span>
    {#if appState.selectedProject}
      <div class="header-actions">
        <button class="icon-btn" title="New worktree" onclick={() => { showNewWorktreeInput = !showNewWorktreeInput; }}>+wt</button>
        <button class="icon-btn" title="New agent" onclick={() => { showSpawnMenu = showSpawnMenu === "__root__" ? null : "__root__"; }}>+agent</button>
      </div>
    {/if}
  </div>

  {#if errorMsg}
    <div class="error-bar">{errorMsg}</div>
  {/if}

  {#if showNewWorktreeInput}
    <!-- svelte-ignore a11y_autofocus -->
    <div class="inline-input">
      <input
        type="text"
        placeholder="worktree name..."
        bind:value={newWorktreeName}
        onkeydown={handleWorktreeKeydown}
        disabled={isCreateWorktreePending()}
        autofocus
      />
      <button class="input-btn" onclick={createWorktree} disabled={!newWorktreeName.trim() || isCreateWorktreePending()}>
        {isCreateWorktreePending() ? "creating..." : "create"}
      </button>
    </div>
  {/if}

  {#if showSpawnMenu === "__root__"}
    <div class="spawn-menu">
      {#each tools as tool}
        <button class="spawn-btn" onclick={() => spawnAgent(tool, null)} disabled={isSpawnPending(tool, null)}>
          {isSpawnPending(tool, null) ? `spawning ${tool}...` : `spawn ${tool}`}
        </button>
      {/each}
    </div>
  {/if}

  <div class="worktree-list">
    {#if !appState.selectedProject}
      <div class="empty">Select a project to view worktrees.</div>
    {:else if worktrees.length === 0}
      <div class="empty">No sessions yet.</div>
    {:else}
      {#each worktrees as wt (wt.path || wt.name)}
        <div class="worktree-group" class:unassigned={!wt.path}>
          <div class="worktree-header">
            {#if wt.path}
              <span class="worktree-name">{wt.name}</span>
              {#if wt.branch}
                <span class="worktree-branch">{wt.branch}</span>
              {/if}
              <button
                class="wt-action"
                title="Spawn agent in this worktree"
                disabled={Boolean(wt.pending)}
                onclick={() => { showSpawnMenu = showSpawnMenu === wt.path ? null : wt.path; }}
              >+</button>
            {:else}
              <span class="worktree-name dim">{wt.pending ? `${wt.name}...` : "Pending assignment..."}</span>
            {/if}
          </div>

          {#if showSpawnMenu === wt.path && wt.path}
            <div class="spawn-menu">
              {#each tools as tool}
                <button class="spawn-btn" onclick={() => spawnAgent(tool, wt.path)} disabled={isSpawnPending(tool, wt.path)}>
                  {isSpawnPending(tool, wt.path) ? `spawning ${tool}...` : `spawn ${tool}`}
                </button>
              {/each}
            </div>
          {/if}

          {#if wt.agents.length > 0}
            <div class="agent-list">
              {#each wt.agents as agent (agent.id)}
                {@const active = agent.id === appState.selectedSessionId}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="agent-row"
                  class:active
                  onclick={() => focusAgent(agent)}
                  role="button"
                  tabindex="0"
                  title={agent.id}
                >
                  <span class="agent-dot" style="background: {statusDot(agent)}"></span>
                  <span class="agent-label">{agentLabel(agent)}</span>
                  {#if agent.role}
                    <span class="agent-role">({agent.role})</span>
                  {/if}
                  <span class="agent-status">{agentStatusLabel(agent)}</span>
                  <span class="agent-actions" class:visible={agent.pending}>
                    {#if agent.status === "running"}
                      <button class="agent-action" title="Stop" onclick={(e) => stopAgent(e, agent)} disabled={isAgentActionPending(agent.id)}>
                        {isAgentActionPending(agent.id) ? "..." : "■"}
                      </button>
                    {/if}
                    {#if !agent.pending}
                      <button class="agent-action agent-action-kill" title="Kill" onclick={(e) => killAgent(e, agent)} disabled={isAgentActionPending(agent.id)}>
                        {isAgentActionPending(agent.id) ? "..." : "×"}
                      </button>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</section>

<style>
  .panel {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 16px;
    flex-shrink: 0;
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }

  .header-actions {
    display: flex;
    gap: 4px;
  }

  .icon-btn {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    transition: background 100ms, border-color 100ms;
  }

  .icon-btn:hover {
    background: var(--bg-surface-hover);
    border-color: var(--border-hover);
  }

  .error-bar {
    padding: 4px 12px;
    font-size: 11px;
    color: var(--red);
    background: rgba(251, 113, 133, 0.08);
    border-bottom: 1px solid rgba(251, 113, 133, 0.15);
  }

  .inline-input {
    display: flex;
    gap: 4px;
    padding: 4px 12px 8px;
  }

  .inline-input input {
    flex: 1;
    padding: 4px 8px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .inline-input input:focus {
    border-color: var(--border-active);
  }

  .input-btn {
    padding: 4px 8px;
    border-radius: 5px;
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(125, 211, 252, 0.2);
    color: var(--accent);
    font-size: 11px;
    transition: background 100ms;
  }

  .input-btn:hover:enabled {
    background: rgba(56, 189, 248, 0.18);
  }

  .input-btn:disabled,
  .spawn-btn:disabled,
  .agent-action:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .spawn-menu {
    display: flex;
    gap: 4px;
    padding: 2px 12px 6px 20px;
  }

  .spawn-btn {
    padding: 3px 8px;
    border-radius: 5px;
    font-size: 11px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    transition: background 100ms, border-color 100ms;
  }

  .spawn-btn:hover {
    background: var(--bg-surface-hover);
    border-color: var(--border-hover);
    color: var(--text);
  }

  .spawn-btn:disabled:hover {
    background: var(--bg-surface);
    border-color: var(--border);
    color: var(--text-secondary);
  }

  .worktree-list {
    overflow-y: auto;
    padding: 0 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .worktree-group {
    padding: 4px 0;
  }

  .worktree-group + .worktree-group {
    border-top: 1px solid var(--border);
    padding-top: 8px;
    margin-top: 4px;
  }

  .worktree-group.unassigned {
    opacity: 0.5;
  }

  .worktree-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 12px;
    min-height: 24px;
  }

  .worktree-name {
    font-weight: 600;
    font-size: 12px;
    color: var(--text);
  }

  .worktree-name.dim {
    font-weight: 400;
    font-style: italic;
    color: var(--text-dim);
  }

  .worktree-branch {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .wt-action {
    font-size: 12px;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    opacity: 0;
    transition: opacity 100ms, background 100ms;
  }

  .worktree-header:hover .wt-action {
    opacity: 1;
  }

  .wt-action:hover {
    background: var(--bg-surface);
    color: var(--text);
  }

  .wt-action:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .wt-action:disabled:hover {
    background: transparent;
    color: var(--text-dim);
  }

  .agent-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 2px 0 0;
  }

  .agent-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px 5px 20px;
    border-radius: 6px;
    border: 1px solid transparent;
    text-align: left;
    font-size: 12px;
    cursor: pointer;
    transition: background 100ms, border-color 100ms;
  }

  .agent-row:hover {
    background: var(--bg-surface);
  }

  .agent-row.active {
    background: var(--bg-surface-active);
    border-color: var(--border-active);
  }

  .agent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .agent-label {
    font-weight: 500;
    color: var(--text);
  }

  .agent-role {
    color: var(--text-dim);
    font-size: 11px;
  }

  .agent-status {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 10px;
  }

  .agent-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 100ms;
  }

  .agent-row:hover .agent-actions {
    opacity: 1;
  }

  .agent-actions.visible {
    opacity: 1;
  }

  .agent-action {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--text-dim);
    transition: background 100ms, color 100ms;
  }

  .agent-action:hover {
    background: var(--bg-surface-hover);
    color: var(--text);
  }

  .agent-action:disabled:hover {
    background: transparent;
    color: var(--text-dim);
  }

  .agent-action-kill:hover {
    color: var(--red);
  }

  .empty {
    padding: 24px 16px;
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
