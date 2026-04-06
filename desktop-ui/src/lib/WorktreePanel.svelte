<script>
  import { invoke } from "@tauri-apps/api/core";
  import { getState, openService, openSession, isActionPending, isSessionActionBlocked, trackAction } from "../stores/state.svelte.js";
  import { getTerminal } from "./terminal-instance.svelte.js";
  import { formatRelativeRecency } from "../../../src/recency.ts";

  const appState = getState();
  const termInstance = getTerminal();

  let showNewWorktreeInput = $state(false);
  let newWorktreeName = $state("");
  let showSpawnMenu = $state(null);
  let showServiceInputFor = $state(null);
  let serviceCommand = $state("");
  let removeWorktreePath = $state(null);
  let renameSessionId = $state(null);
  let renameDraft = $state("");
  let forkMenu = $state(null);
  let migrateSessionId = $state(null);
  let errorMsg = $state(null);

  // Group sessions by worktree.
  // Base session list comes from daemon (includes offline/stopped).
  // Statusline provides enrichment (label, role, headline, metadata).
  let worktrees = $derived.by(() => {
    const daemonSessions = appState.daemonSessions;
    const services = appState.serviceList;
    const sl = appState.statusline;
    const slSessions = sl?.sessions ?? [];
    const meta = sl?.metadata ?? {};
    const listedWorktrees = appState.worktreeList ?? [];

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
      ensureGroup(wt.path, () => ({ path: wt.path, name: wt.name, branch: wt.branch, agents: [], services: [] }));
    }

    for (const s of daemonSessions) {
      const slData = slById.get(s.id);
      const m = meta[s.id];
      const ctx = m?.context;
      const wtPath = s.worktreePath || slData?.worktreePath || ctx?.worktreePath || null;
      const wtName = ctx?.worktreeName || (wtPath ? wtPath.split("/").pop() : null);
      const branch = ctx?.branch || null;
      const key = wtPath || "__unassigned__";

      const group = ensureGroup(key, () => ({ path: wtPath, name: wtName || "Unassigned", branch, agents: [], services: [] }));
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

    for (const service of services) {
      const wtPath = service.worktreePath || null;
      const listed = listedWorktrees.find((entry) => entry.path === wtPath) || null;
      const key = wtPath || "__unassigned__";
      const group = ensureGroup(key, () => ({
        path: wtPath,
        name: listed?.name || service.worktreeName || wtPath?.split("/").pop() || "Unassigned",
        branch: listed?.branch || service.worktreeBranch || null,
        agents: [],
        services: [],
      }));
      group.services.push(service);
    }

    for (const group of groups.values()) {
      group.agents.sort((a, b) => {
        const aIndex = Number.isFinite(a.tmuxWindowIndex) ? a.tmuxWindowIndex : Number.MAX_SAFE_INTEGER;
        const bIndex = Number.isFinite(b.tmuxWindowIndex) ? b.tmuxWindowIndex : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return agentLabel(a).localeCompare(agentLabel(b));
      });
      group.services.sort((a, b) => {
        const aIndex = Number.isFinite(a.tmuxWindowIndex) ? a.tmuxWindowIndex : Number.MAX_SAFE_INTEGER;
        const bIndex = Number.isFinite(b.tmuxWindowIndex) ? b.tmuxWindowIndex : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return serviceLabel(a).localeCompare(serviceLabel(b));
      });
    }

    const result = orderedKeys.map((key) => groups.get(key));

    return result.sort((a, b) => {
      const aPendingCreate = String(a.path || "").startsWith("pending-worktree:");
      const bPendingCreate = String(b.path || "").startsWith("pending-worktree:");
      if (aPendingCreate !== bPendingCreate) return aPendingCreate ? 1 : -1;
      const aUnassigned = a.path === null;
      const bUnassigned = b.path === null;
      if (aUnassigned !== bUnassigned) return aUnassigned ? 1 : -1;
      return 0;
    });
  });

  function statusDot(agent) {
    if (agent.status === "offline" && !agent.pending) return "var(--text-dim)";
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

  function isActiveNativeChatSession(agent) {
    return (
      appState.interactionMode === "native-chat" &&
      appState.nativeChatSessionId != null &&
      agent?.id === appState.nativeChatSessionId
    );
  }

  function agentStatusLabel(agent) {
    if (agent.status === "offline" && !agent.pending) return "offline";
    if (agent.pending && agent.status === "starting") return "starting";
    if (agent.pending && agent.status === "stopping") return "stopping";
    if (agent.pending && agent.status === "killing") return "killing";
    if (agent.pending && agent.status === "migrating") return "migrating";
    const semantic = agent.semantic || null;
    if (semantic) {
      let base = agent.status || "idle";
      if (semantic.attention === "error") base = "error";
      else if (semantic.workflowState === "blocked" || semantic.attention === "blocked") base = "blocked";
      else if (semantic.activity === "done") base = "done";
      else if (semantic.activity === "waiting") base = "waiting";
      else if (semantic.activity === "running") base = "working";
      else if (semantic.workflowState === "waiting_on_me" || semantic.availability === "needs_input") base = "needs input";
      else if (agent.status === "running") base = "working";
      else if (agent.status === "waiting") base = "thinking";

      let hint = null;
      if (semantic.workflowState === "waiting_on_me" || semantic.availability === "needs_input") hint = "on you";
      else if (semantic.workflowState === "waiting_on_them") hint = "on them";
      else if (!isActiveNativeChatSession(agent) && (semantic.unreadCount ?? 0) > 0) {
        hint = `${Math.min(semantic.unreadCount, 99)} unread`;
      } else if (!isActiveNativeChatSession(agent) && (semantic.pendingDeliveryCount ?? 0) > 0) {
        hint = `${Math.min(semantic.pendingDeliveryCount, 99)} pending`;
      }

      return hint && hint !== base ? `${base} · ${hint}` : base;
    }
    return agent.status || "idle";
  }

  function agentStatusParts(agent) {
    const raw = agentStatusLabel(agent);
    const [primary, secondary] = raw.split(" · ");
    return {
      primary: primary || raw,
      secondary: secondary || null,
    };
  }

  function agentStatusTone(agent) {
    if (agent.status === "offline" && !agent.pending) return "neutral";
    const semantic = agent.semantic || null;
    if (semantic?.attention === "error") return "error";
    if (semantic?.workflowState === "blocked" || semantic?.attention === "blocked") return "blocked";
    if (semantic?.workflowState === "waiting_on_me" || semantic?.availability === "needs_input") return "waiting";
    if (
      !isActiveNativeChatSession(agent) &&
      ((semantic?.unreadCount ?? 0) > 0 || (semantic?.pendingDeliveryCount ?? 0) > 0)
    ) {
      return "info";
    }
    if (semantic?.activity === "done") return "success";
    if (semantic?.activity === "running" || semantic?.activity === "waiting") return "active";
    if (agent.status === "running") return "active";
    return "neutral";
  }

  function serviceLabel(service) {
    return service.label || service.command || service.id;
  }

  function serviceStatusLabel(service) {
    if (service.pendingAction === "starting" || service.pending) return "starting";
    if (service.pendingAction === "stopping") return "stopping";
    if (service.pendingAction === "graveyarding") return "removing";
    if (service.status === "offline") return "offline";
    if (service.status === "exited") return "exited";
    return "running";
  }

  function lastUsedLabel(entry) {
    const formatted = formatRelativeRecency(entry?.lastUsedAt || null);
    return formatted ? `used ${formatted}` : null;
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
    const project = appState.selectedProject;
    if (!project) return;
    await openSession(
      termInstance.terminal,
      project.path,
      agent.id,
      agentLabel(agent),
    );
  }

  async function focusService(service) {
    const project = appState.selectedProject;
    if (!project) return;
    if (service.status === "offline") {
      if (isResumeServicePending(service.id)) return;
      try {
        await trackAction(
          {
            kind: "resume-service",
            message: `Restoring ${serviceLabel(service)}...`,
            projectPath: project.path,
            serviceId: service.id,
            label: serviceLabel(service),
            command: service.command || null,
            worktreePath: service.worktreePath || null,
            reconcile: () => ({ serviceId: service.id }),
          },
          () => invoke("service_resume", { projectPath: project.path, serviceId: service.id }),
        );
      } catch (err) {
        showError(`Service resume failed: ${err}`);
      }
      return;
    }
    await openService(
      termInstance.terminal,
      project.path,
      service.id,
      serviceLabel(service),
      service.tmuxWindowId || null,
    );
  }

  async function killAgent(e, agent) {
    e.stopPropagation();
    const project = appState.selectedProject;
    if (!project || isAgentActionPending(agent.id, "kill")) return;
    try {
      await trackAction(
        {
          kind: "kill",
          message: `Killing ${agentLabel(agent)}...`,
          projectPath: project.path,
          sessionId: agent.id,
          reconcile: () => ({ sessionId: agent.id }),
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
    if (!project || isAgentActionPending(agent.id, "stop")) return;
    try {
      await trackAction(
        {
          kind: "stop",
          message: `Stopping ${agentLabel(agent)}...`,
          projectPath: project.path,
          sessionId: agent.id,
          reconcile: () => ({ sessionId: agent.id }),
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
          reconcile: (result) => ({ sessionId: result?.sessionId }),
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

  function availableWorktreeTargets(agent) {
    const currentPath = agent.worktreePath || null;
    return worktrees.filter((wt) => wt.path && wt.path !== currentPath && !wt.pending);
  }

  function closeAgentMenus() {
    renameSessionId = null;
    renameDraft = "";
    forkMenu = null;
    migrateSessionId = null;
  }

  function closeWorktreeMenus() {
    showSpawnMenu = null;
    removeWorktreePath = null;
  }

  function openRename(e, agent) {
    e.stopPropagation();
    renameSessionId = renameSessionId === agent.id ? null : agent.id;
    renameDraft = agent.label || "";
    forkMenu = null;
    migrateSessionId = null;
  }

  function openFork(e, agent, defaultWorktreePath) {
    e.stopPropagation();
    const next =
      forkMenu?.sessionId === agent.id
        ? null
        : {
            sessionId: agent.id,
            worktreePath: agent.worktreePath || defaultWorktreePath || null,
          };
    forkMenu = next;
    renameSessionId = null;
    migrateSessionId = null;
  }

  function openMigrate(e, agent) {
    e.stopPropagation();
    migrateSessionId = migrateSessionId === agent.id ? null : agent.id;
    renameSessionId = null;
    forkMenu = null;
  }

  async function forkAgent(agent, tool, worktreePath) {
    const project = appState.selectedProject;
    if (!project || isForkPending(agent.id)) return;
    forkMenu = null;
    try {
      await trackAction(
        {
          kind: "fork",
          message: `Forking ${agentLabel(agent)} to ${tool}...`,
          projectPath: project.path,
          sourceSessionId: agent.id,
          tool,
          worktreePath: worktreePath || null,
          reconcile: (result) => ({ sessionId: result?.sessionId }),
        },
        () =>
          invoke("agent_fork", {
            projectPath: project.path,
            sessionId: agent.id,
            tool,
            worktree: worktreePath || null,
          }),
      );
    } catch (err) {
      showError(`Fork failed: ${err}`);
    }
  }

  async function renameAgent(agent) {
    const project = appState.selectedProject;
    if (!project || isRenamePending(agent.id)) return;
    const label = renameDraft.trim();
    try {
      await trackAction(
        {
          kind: "rename",
          message: `Renaming ${agentLabel(agent)}...`,
          projectPath: project.path,
          sessionId: agent.id,
          label,
          reconcile: () => ({ sessionId: agent.id }),
        },
        () =>
          invoke("agent_rename", {
            projectPath: project.path,
            sessionId: agent.id,
            label,
          }),
      );
      closeAgentMenus();
    } catch (err) {
      showError(`Rename failed: ${err}`);
    }
  }

  async function migrateAgent(agent, worktreePath) {
    const project = appState.selectedProject;
    if (!project || isMigratePending(agent.id)) return;
    migrateSessionId = null;
    try {
      await trackAction(
        {
          kind: "migrate",
          message: `Migrating ${agentLabel(agent)}...`,
          projectPath: project.path,
          sessionId: agent.id,
          worktreePath,
          reconcile: () => ({ sessionId: agent.id, worktreePath }),
        },
        () =>
          invoke("agent_migrate", {
            projectPath: project.path,
            sessionId: agent.id,
            worktree: worktreePath,
          }),
      );
    } catch (err) {
      showError(`Migrate failed: ${err}`);
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
          reconcile: (result) => ({ worktreePath: result?.path }),
        },
        () => invoke("worktree_create", { projectPath: project.path, name }),
      );
      newWorktreeName = "";
      showNewWorktreeInput = false;
    } catch (err) {
      showError(`Worktree create failed: ${err}`);
    }
  }

  async function createService(worktreePath) {
    const project = appState.selectedProject;
    if (!project || isCreateServicePending(worktreePath)) return;
    const command = serviceCommand.trim();
    const label = command || "shell";
    try {
      await trackAction(
        {
          kind: "create-service",
          message: command ? `Starting ${label}...` : "Starting shell...",
          projectPath: project.path,
          worktreePath: worktreePath || null,
          command,
          label,
          reconcile: (result) => ({ serviceId: result?.serviceId }),
        },
        () =>
          invoke("service_create", {
            projectPath: project.path,
            command: command || null,
            worktree: worktreePath || null,
          }),
      );
      serviceCommand = "";
      showServiceInputFor = null;
    } catch (err) {
      showError(`Service create failed: ${err}`);
    }
  }

  async function removeWorktree(path, name) {
    const project = appState.selectedProject;
    if (!project || isRemoveWorktreePending(path)) return;
    try {
      await trackAction(
        {
          kind: "remove-worktree",
          message: `Removing ${name}...`,
          projectPath: project.path,
          worktreePath: path,
          reconcile: () => ({ worktreePath: path }),
        },
        () => invoke("worktree_remove", { projectPath: project.path, path }),
      );
      removeWorktreePath = null;
    } catch (err) {
      showError(`Worktree remove failed: ${err}`);
    }
  }

  async function stopService(e, service) {
    e.stopPropagation();
    const project = appState.selectedProject;
    if (!project) return;
    try {
      if (service.status === "offline" || service.status === "exited") {
        if (isRemoveServicePending(service.id)) return;
        await trackAction(
          {
            kind: "remove-service",
            message: `Removing ${serviceLabel(service)}...`,
            projectPath: project.path,
            serviceId: service.id,
            reconcile: () => ({ serviceId: service.id }),
          },
          () => invoke("service_remove", { projectPath: project.path, serviceId: service.id }),
        );
      } else {
        if (isStopServicePending(service.id)) return;
        await trackAction(
          {
            kind: "stop-service",
            message: `Stopping ${serviceLabel(service)}...`,
            projectPath: project.path,
            serviceId: service.id,
            reconcile: () => ({ serviceId: service.id }),
          },
          () => invoke("service_stop", { projectPath: project.path, serviceId: service.id }),
        );
      }
    } catch (err) {
      showError(`Service action failed: ${err}`);
    }
  }

  function isAgentActionPending(sessionId, requestedKind = null) {
    return isSessionActionBlocked(appState.selectedProject?.path, sessionId, requestedKind);
  }

  function isForkPending(sessionId) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "fork",
      sourceSessionId: sessionId,
    });
  }

  function isRenamePending(sessionId) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "rename",
      sessionId,
    });
  }

  function isMigratePending(sessionId) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "migrate",
      sessionId,
    });
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

  function isRemoveWorktreePending(path) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "remove-worktree",
      worktreePath: path,
    });
  }

  function isCreateServicePending(worktreePath) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "create-service",
      worktreePath: worktreePath || null,
    });
  }

  function isStopServicePending(serviceId) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "stop-service",
      serviceId,
    });
  }

  function isResumeServicePending(serviceId) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "resume-service",
      serviceId,
    });
  }

  function isRemoveServicePending(serviceId) {
    return isActionPending({
      projectPath: appState.selectedProject?.path,
      kind: "remove-service",
      serviceId,
    });
  }

  function handleWorktreeKeydown(e) {
    if (e.key === "Enter") createWorktree();
    if (e.key === "Escape") { showNewWorktreeInput = false; newWorktreeName = ""; }
  }

  function handleServiceKeydown(e, worktreePath) {
    if (e.key === "Enter") createService(worktreePath);
    if (e.key === "Escape") { showServiceInputFor = null; serviceCommand = ""; }
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
      <div class="empty">No agents or services yet.</div>
    {:else}
      {#each worktrees as wt (wt.path || wt.name)}
        <div class="worktree-group" class:unassigned={!wt.path}>
          <div class="worktree-header">
            {#if wt.path}
              <span class="worktree-name">{wt.name}</span>
              {#if wt.branch}
                <span class="worktree-branch">{wt.branch}</span>
              {/if}
              {#if !wt.pending}
                <button
                  class="wt-action wt-action-danger"
                  title={wt.agents.length > 0 || wt.services?.length > 0 ? "Worktree has attached agents or services" : "Remove worktree"}
                  disabled={Boolean(wt.pending) || wt.agents.length > 0 || wt.services?.length > 0 || isRemoveWorktreePending(wt.path)}
                  onclick={() => { removeWorktreePath = removeWorktreePath === wt.path ? null : wt.path; showSpawnMenu = null; }}
                >×</button>
              {/if}
              <button
                class="wt-action"
                title="Spawn agent in this worktree"
                disabled={Boolean(wt.pending)}
                onclick={() => { showSpawnMenu = showSpawnMenu === wt.path ? null : wt.path; }}
              >+</button>
              <button
                class="wt-action"
                title="Start service in this worktree"
                disabled={Boolean(wt.pending)}
                onclick={() => { showServiceInputFor = showServiceInputFor === wt.path ? null : wt.path; serviceCommand = ""; }}
              >v</button>
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

          {#if showServiceInputFor === wt.path && wt.path}
            <!-- svelte-ignore a11y_autofocus -->
            <div class="inline-input">
              <input
                type="text"
                placeholder="command... (empty = shell)"
                bind:value={serviceCommand}
                onkeydown={(e) => handleServiceKeydown(e, wt.path)}
                disabled={isCreateServicePending(wt.path)}
                autofocus
              />
              <button class="input-btn" onclick={() => createService(wt.path)} disabled={isCreateServicePending(wt.path)}>
                {isCreateServicePending(wt.path) ? "starting..." : "start"}
              </button>
            </div>
          {/if}

          {#if removeWorktreePath === wt.path && wt.path}
            <div class="worktree-confirm">
              <span class="inline-hint">Remove {wt.name}? This deletes the checkout.</span>
              <button class="inline-chip confirm" onclick={() => removeWorktree(wt.path, wt.name)} disabled={isRemoveWorktreePending(wt.path)}>
                {isRemoveWorktreePending(wt.path) ? "removing..." : "remove"}
              </button>
              <button class="inline-chip" onclick={() => { removeWorktreePath = null; }}>cancel</button>
            </div>
          {/if}

          {#if wt.agents.length > 0}
            <div class="agent-list">
              {#each wt.agents as agent (agent.id)}
                {@const active = agent.id === appState.selectedSessionId}
                {@const statusParts = agentStatusParts(agent)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div class="agent-block">
                  <div
                    class="agent-row"
                    class:active
                    onclick={() => focusAgent(agent)}
                    role="button"
                    tabindex="0"
                    title={agent.id}
                  >
                    <span class="agent-dot" style="background: {statusDot(agent)}"></span>
                    <span class="agent-identity">
                      <span class="agent-label">{agentLabel(agent)}</span>
                      {#if agent.role}
                        <span class="agent-role">({agent.role})</span>
                      {/if}
                    </span>
                    <span class="agent-meta">
                      <span class="agent-status" data-tone={agentStatusTone(agent)}>
                        <span class="agent-status-primary">{statusParts.primary}</span>
                        {#if statusParts.secondary}
                          <span class="agent-status-secondary">{statusParts.secondary}</span>
                        {/if}
                        {#if lastUsedLabel(agent)}
                          <span class="agent-status-secondary">{lastUsedLabel(agent)}</span>
                        {/if}
                      </span>
                      <span class="agent-actions" class:visible={agent.pending || renameSessionId === agent.id || forkMenu?.sessionId === agent.id || migrateSessionId === agent.id}>
                        {#if agent.status === "running"}
                          <button class="agent-action" title="Fork" onclick={(e) => openFork(e, agent, wt.path)} disabled={isAgentActionPending(agent.id, "fork")}>
                            ↗
                          </button>
                          <button class="agent-action" title="Rename" onclick={(e) => openRename(e, agent)} disabled={isAgentActionPending(agent.id, "rename")}>
                            ✎
                          </button>
                          <button class="agent-action" title="Migrate" onclick={(e) => openMigrate(e, agent)} disabled={isAgentActionPending(agent.id, "migrate")}>
                            ⇄
                          </button>
                          <button class="agent-action" title="Stop" onclick={(e) => stopAgent(e, agent)} disabled={isAgentActionPending(agent.id, "stop")}>
                            {isAgentActionPending(agent.id, "stop") ? "..." : "■"}
                          </button>
                        {/if}
                        {#if !agent.pending || agent.pendingAction === "stop"}
                          <button class="agent-action agent-action-kill" title="Kill" onclick={(e) => killAgent(e, agent)} disabled={isAgentActionPending(agent.id, "kill")}>
                            {isAgentActionPending(agent.id, "kill") ? "..." : "×"}
                          </button>
                        {/if}
                      </span>
                    </span>
                  </div>

                  {#if renameSessionId === agent.id}
                    <!-- svelte-ignore a11y_autofocus -->
                    <div class="agent-inline">
                      <input
                        class="agent-inline-input"
                        bind:value={renameDraft}
                        placeholder="agent label..."
                        autofocus
                        onclick={(e) => e.stopPropagation()}
                        onkeydown={(e) => {
                          if (e.key === "Enter") renameAgent(agent);
                          if (e.key === "Escape") closeAgentMenus();
                        }}
                      />
                      <button class="inline-chip confirm" onclick={(e) => { e.stopPropagation(); renameAgent(agent); }} disabled={isRenamePending(agent.id)}>
                        {isRenamePending(agent.id) ? "saving..." : "save"}
                      </button>
                      <button class="inline-chip" onclick={(e) => { e.stopPropagation(); closeAgentMenus(); }}>cancel</button>
                    </div>
                  {/if}

                  {#if forkMenu?.sessionId === agent.id}
                    <div class="agent-inline stacked">
                      <div class="inline-label">Fork into</div>
                      <div class="inline-options">
                        {#each availableWorktreeTargets(agent) as target}
                          <button
                            class="inline-chip"
                            class:selected={forkMenu.worktreePath === target.path}
                            onclick={(e) => { e.stopPropagation(); forkMenu = { ...forkMenu, worktreePath: target.path }; }}
                          >
                            {target.name}
                          </button>
                        {/each}
                        <button
                          class="inline-chip"
                          class:selected={forkMenu.worktreePath === (agent.worktreePath || wt.path || null)}
                          onclick={(e) => { e.stopPropagation(); forkMenu = { ...forkMenu, worktreePath: agent.worktreePath || wt.path || null }; }}
                        >
                          current
                        </button>
                      </div>
                      <div class="inline-options">
                        {#each tools as tool}
                          <button
                            class="inline-chip confirm"
                            onclick={(e) => { e.stopPropagation(); forkAgent(agent, tool, forkMenu.worktreePath); }}
                            disabled={isForkPending(agent.id)}
                          >
                            {isForkPending(agent.id) ? `forking ${tool}...` : `fork ${tool}`}
                          </button>
                        {/each}
                        <button class="inline-chip" onclick={(e) => { e.stopPropagation(); closeAgentMenus(); }}>cancel</button>
                      </div>
                    </div>
                  {/if}

                  {#if migrateSessionId === agent.id}
                    <div class="agent-inline stacked">
                      <div class="inline-label">Move to worktree</div>
                      <div class="inline-options">
                        {#each availableWorktreeTargets(agent) as target}
                          <button
                            class="inline-chip confirm"
                            onclick={(e) => { e.stopPropagation(); migrateAgent(agent, target.path); }}
                            disabled={isMigratePending(agent.id)}
                          >
                            {target.name}
                          </button>
                        {/each}
                        {#if availableWorktreeTargets(agent).length === 0}
                          <span class="inline-hint">No alternate worktrees.</span>
                        {/if}
                        <button class="inline-chip" onclick={(e) => { e.stopPropagation(); closeAgentMenus(); }}>cancel</button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if wt.services?.length > 0}
            <div class="service-list">
              {#each wt.services as service (service.id)}
                <div
                  class="service-row"
                  onclick={() => focusService(service)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      focusService(service);
                    }
                  }}
                  role="button"
                  tabindex="0"
                  title={service.command || service.id}
                >
                  <span class="agent-dot" style="background: rgba(125, 211, 252, 0.95);"></span>
                  <span class="agent-identity">
                    <span class="agent-label">{serviceLabel(service)}</span>
                    {#if service.foregroundCommand}
                      <span class="agent-role">({service.foregroundCommand})</span>
                    {/if}
                  </span>
                  <span class="agent-meta">
                    <span class="agent-status" data-tone={service.status === "offline" || service.status === "exited" ? "blocked" : "active"}>
                      <span class="agent-status-primary">{serviceStatusLabel(service)}</span>
                      {#if service.previewLine}
                        <span class="agent-status-secondary" title={service.previewLine}>{service.previewLine}</span>
                      {/if}
                      {#if lastUsedLabel(service)}
                        <span class="agent-status-secondary">{lastUsedLabel(service)}</span>
                      {/if}
                    </span>
                    <span class="agent-actions visible">
                      <button
                        class="agent-action"
                        title={service.status === "offline" || service.status === "exited" ? "Remove service" : "Stop service"}
                        onclick={(e) => stopService(e, service)}
                        disabled={isStopServicePending(service.id) || isResumeServicePending(service.id) || isRemoveServicePending(service.id)}
                      >
                        {isStopServicePending(service.id) || isResumeServicePending(service.id) || isRemoveServicePending(service.id)
                          ? "..."
                          : service.status === "offline" || service.status === "exited"
                            ? "×"
                            : "■"}
                      </button>
                    </span>
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

  .wt-action-danger:hover {
    color: var(--red);
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

  .service-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 0 0;
  }

  .worktree-confirm {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px 6px 20px;
    flex-wrap: wrap;
  }

  .agent-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
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

  .service-row {
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

  .service-row:hover {
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
    flex: 1;
    font-weight: 500;
    color: var(--text);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-identity {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }

  .agent-role {
    color: var(--text-dim);
    font-size: 11px;
    flex-shrink: 0;
  }

  .agent-meta {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .agent-status {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    min-width: 64px;
    max-width: 88px;
    text-align: right;
    font-size: 10px;
    line-height: 1.15;
    flex-shrink: 0;
  }

  .agent-status-primary {
    color: var(--text-dim);
  }

  .agent-status-secondary {
    color: rgba(148, 163, 184, 0.92);
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-status[data-tone="active"] .agent-status-primary {
    color: rgba(167, 243, 208, 0.96);
  }

  .agent-status[data-tone="success"] .agent-status-primary {
    color: rgba(187, 247, 208, 0.98);
  }

  .agent-status[data-tone="waiting"] .agent-status-primary,
  .agent-status[data-tone="waiting"] .agent-status-secondary {
    color: rgba(253, 224, 71, 0.96);
  }

  .agent-status[data-tone="blocked"] .agent-status-primary,
  .agent-status[data-tone="blocked"] .agent-status-secondary,
  .agent-status[data-tone="error"] .agent-status-primary,
  .agent-status[data-tone="error"] .agent-status-secondary {
    color: rgba(252, 165, 165, 0.98);
  }

  .agent-status[data-tone="info"] .agent-status-secondary {
    color: rgba(125, 211, 252, 0.95);
  }

  .agent-actions {
    display: flex;
    gap: 2px;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    transition: opacity 100ms, max-width 100ms;
    flex-shrink: 0;
  }

  .agent-row:hover .agent-actions {
    max-width: 120px;
    opacity: 1;
  }

  .service-row:hover .agent-actions {
    max-width: 120px;
    opacity: 1;
  }

  .agent-actions.visible {
    max-width: 120px;
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

  .agent-inline {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px 6px 32px;
  }

  .agent-inline.stacked {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .agent-inline-input {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .agent-inline-input:focus {
    border-color: var(--border-active);
  }

  .inline-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }

  .inline-options {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .inline-chip {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    transition: background 100ms, border-color 100ms, color 100ms;
  }

  .inline-chip:hover {
    background: var(--bg-surface-hover);
    border-color: var(--border-hover);
    color: var(--text);
  }

  .inline-chip.selected,
  .inline-chip.confirm {
    border-color: rgba(125, 211, 252, 0.25);
    background: rgba(56, 189, 248, 0.1);
    color: var(--accent);
  }

  .inline-hint {
    font-size: 11px;
    color: var(--text-dim);
  }

  .empty {
    padding: 24px 16px;
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
