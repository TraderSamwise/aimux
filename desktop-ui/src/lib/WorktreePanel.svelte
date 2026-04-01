<script>
  import { getState, selectSession, runTerminal } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";

  const state = getState();
  const termInstance = getTerminal();

  // Group sessions by worktree using metadata context
  let worktrees = $derived.by(() => {
    const sl = state.statusline;
    if (!sl) return [];
    const sessions = sl.sessions ?? [];
    const meta = sl.metadata ?? {};

    // Build worktree groups
    const groups = new Map();

    for (const s of sessions) {
      const m = meta[s.id];
      const ctx = m?.context;
      const wtPath = s.worktreePath || ctx?.worktreePath || null;
      const wtName = ctx?.worktreeName || (wtPath ? wtPath.split("/").pop() : null);
      const branch = ctx?.branch || null;
      const key = wtPath || "__unassigned__";

      if (!groups.has(key)) {
        groups.set(key, {
          path: wtPath,
          name: wtName || "Unassigned",
          branch,
          agents: [],
        });
      }
      const group = groups.get(key);
      // Update branch if we got a better one
      if (branch && !group.branch) group.branch = branch;

      group.agents.push({
        ...s,
        meta: m || null,
        derived: m?.derived || null,
      });
    }

    // Sort: groups with live agents first, then by name
    return [...groups.values()].sort((a, b) => {
      const aLive = a.agents.some((ag) => ag.status === "running");
      const bLive = b.agents.some((ag) => ag.status === "running");
      if (aLive !== bLive) return aLive ? -1 : 1;
      return a.name.localeCompare(b.name);
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
    if (agent.status === "offline") return "var(--text-dim)";
    return "var(--text-dim)";
  }

  function agentLabel(agent) {
    return agent.label || agent.tool || agent.id;
  }

  async function focusAgent(agent) {
    selectSession(agent.id);
    const project = state.selectedProject;
    if (!project || !termInstance.terminal) return;
    await runTerminal(
      termInstance.terminal,
      project.path,
      ["desktop", "focus", "--project", project.path, "--session", agent.id],
      agentLabel(agent),
    );
  }
</script>

<section class="panel">
  <div class="panel-header">
    <span class="section-label">Worktrees</span>
  </div>

  <div class="worktree-list">
    {#if !state.selectedProject}
      <div class="empty">Select a project to view worktrees.</div>
    {:else if worktrees.length === 0}
      <div class="empty">No sessions yet.</div>
    {:else}
      {#each worktrees as wt (wt.path || wt.name)}
        {@const hasAgents = wt.agents.length > 0}
        <div class="worktree-group">
          <div class="worktree-header">
            <span class="worktree-name">{wt.name}</span>
            {#if wt.branch}
              <span class="worktree-branch">{wt.branch}</span>
            {/if}
          </div>

          {#if hasAgents}
            <div class="agent-list">
              {#each wt.agents as agent (agent.id)}
                {@const active = agent.id === state.selectedSessionId}
                <button
                  class="agent-row"
                  class:active
                  onclick={() => focusAgent(agent)}
                  title={agent.id}
                >
                  <span class="agent-dot" style="background: {statusDot(agent)}"></span>
                  <span class="agent-label">{agentLabel(agent)}</span>
                  {#if agent.role}
                    <span class="agent-role">({agent.role})</span>
                  {/if}
                  <span class="agent-status">{agent.status || "idle"}</span>
                </button>
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

  .worktree-branch {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .empty {
    padding: 24px 16px;
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
