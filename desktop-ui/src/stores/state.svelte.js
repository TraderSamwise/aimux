import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Reactive state ────────────────────────────────────────────────

let projects = $state([]);
let selectedProjectPath = $state(null);
let selectedSessionId = $state(null);
let terminalSessionId = $state(null);
let terminalStatus = $state("Idle");

let unlistenOutput = null;
let unlistenExit = null;
let unlistenHeartbeat = null;

// ── In-progress actions ───────────────────────────────────────────

let inFlightActions = $state([]);
let currentAction = $state(null);

function syncCurrentAction() {
  currentAction = inFlightActions.length > 0
    ? inFlightActions[inFlightActions.length - 1].message
    : null;
}

export function beginAction(action) {
  const next = {
    ...action,
    key: action.key || crypto.randomUUID(),
    startedAt: Date.now(),
    phase: action.phase || "requesting",
  };
  inFlightActions = [...inFlightActions, next];
  syncCurrentAction();
  return next.key;
}

export function finishAction(key) {
  inFlightActions = inFlightActions.filter((action) => action.key !== key);
  syncCurrentAction();
}

export function failAction(key) {
  finishAction(key);
}

export function updateAction(key, patch) {
  inFlightActions = inFlightActions.map((action) =>
    action.key === key ? { ...action, ...patch } : action
  );
  syncCurrentAction();
}

async function waitForPaint() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function trackAction(action, run) {
  const key = beginAction(action);
  await waitForPaint();
  try {
    const result = await run();
    const reconcile = typeof action.reconcile === "function" ? action.reconcile(result) : null;
    if (reconcile) {
      updateAction(key, { phase: "awaiting-sync", ...reconcile });
    } else {
      updateAction(key, { phase: "done" });
      finishAction(key);
    }
    return result;
  } catch (error) {
    updateAction(key, { phase: "error", error: String(error) });
    finishAction(key);
    throw error;
  }
}

export function isActionPending(match = {}) {
  return inFlightActions.some((action) =>
    Object.entries(match).every(([key, value]) => action[key] === value)
  );
}

function reconcileActions(incomingProjects) {
  const byPath = new Map(incomingProjects.map((project) => [project.path, project]));
  const finished = [];

  for (const action of inFlightActions) {
    if (action.phase !== "awaiting-sync") continue;
    const project = byPath.get(action.projectPath);
    if (!project) continue;

    if (action.kind === "spawn" && action.sessionId) {
      if ((project.sessions || []).some((session) => session.id === action.sessionId)) {
        finished.push(action.key);
      }
      continue;
    }

    if (action.kind === "create-worktree" && action.worktreePath) {
      if ((project.worktrees || []).some((worktree) => worktree.path === action.worktreePath)) {
        finished.push(action.key);
      }
      continue;
    }

    if (action.kind === "stop" && action.sessionId) {
      const session = (project.sessions || []).find((entry) => entry.id === action.sessionId);
      if (session?.status === "offline") {
        finished.push(action.key);
      }
      continue;
    }

    if (action.kind === "kill" && action.sessionId) {
      const exists = (project.sessions || []).some((entry) => entry.id === action.sessionId);
      if (!exists) {
        finished.push(action.key);
      }
    }
  }

  for (const key of finished) {
    finishAction(key);
  }
}

function applyActionOverlays(project) {
  if (!project) return null;
  const actions = inFlightActions.filter((action) => action.projectPath === project.path);
  if (actions.length === 0) return project;

  const next = {
    ...project,
    sessions: [...(project.sessions || [])],
    worktrees: [...(project.worktrees || [])],
    statusline: project.statusline
      ? {
          ...project.statusline,
          sessions: [...(project.statusline.sessions || [])],
        }
      : null,
  };

  for (const action of actions) {
    if (action.kind === "spawn") {
      const pendingId = `pending-spawn:${action.key}`;
      const pendingSession = {
        id: pendingId,
        tool: action.tool,
        label: action.tool,
        status: "starting",
        pending: true,
        worktreePath: action.worktreePath || null,
      };
      if (!next.sessions.some((session) => session.id === pendingId)) {
        next.sessions = [pendingSession, ...next.sessions];
      }
      if (next.statusline && !next.statusline.sessions.some((session) => session.id === pendingId)) {
        next.statusline.sessions = [pendingSession, ...next.statusline.sessions];
      }
    }

    if (action.kind === "create-worktree") {
      const pendingPath = `pending-worktree:${action.key}`;
      const pendingWorktree = {
        name: action.worktreeName,
        path: pendingPath,
        branch: "creating",
        pending: true,
      };
      if (!next.worktrees.some((worktree) => worktree.path === pendingPath)) {
        next.worktrees = [...next.worktrees, pendingWorktree];
      }
    }

    if (action.kind === "stop" || action.kind === "kill") {
      next.sessions = next.sessions.map((session) =>
        session.id === action.sessionId
          ? {
              ...session,
              pending: true,
              pendingAction: action.kind,
              status: action.kind === "stop" ? "stopping" : "killing",
            }
          : session
      );
      if (next.statusline) {
        next.statusline.sessions = next.statusline.sessions.map((session) =>
          session.id === action.sessionId
            ? {
                ...session,
                pending: true,
                pendingAction: action.kind,
                status: action.kind === "stop" ? "stopping" : "killing",
              }
            : session
        );
      }
    }
  }

  return next;
}

// ── State getters ─────────────────────────────────────────────────

export function getState() {
  return {
    get projects() { return projects; },
    get selectedProjectPath() { return selectedProjectPath; },
    set selectedProjectPath(v) { selectedProjectPath = v; },
    get selectedSessionId() { return selectedSessionId; },
    set selectedSessionId(v) { selectedSessionId = v; },
    get terminalSessionId() { return terminalSessionId; },
    get terminalStatus() { return terminalStatus; },
    get currentAction() { return currentAction; },
    get inFlightActions() { return inFlightActions; },
    get selectedProject() {
      return applyActionOverlays(projects.find((p) => p.path === selectedProjectPath) || null);
    },
    get statusline() {
      const project = applyActionOverlays(projects.find((p) => p.path === selectedProjectPath) || null);
      return project?.statusline || null;
    },
    get daemonSessions() {
      const project = applyActionOverlays(projects.find((p) => p.path === selectedProjectPath) || null);
      return project?.sessions || [];
    },
    get worktreeList() {
      const project = applyActionOverlays(projects.find((p) => p.path === selectedProjectPath) || null);
      return project?.worktrees || [];
    },
  };
}

// ── Heartbeat listener (Rust pushes events, JS just receives) ─────

function onHeartbeat(event) {
  const incoming = event.payload?.projects || [];
  incoming.sort((a, b) => a.name.localeCompare(b.name));
  reconcileActions(incoming);
  projects = incoming;

  if (!selectedProjectPath && projects.length > 0) {
    selectedProjectPath = projects[0].path;
  }
  if (selectedProjectPath && !projects.some((p) => p.path === selectedProjectPath)) {
    selectedProjectPath = projects[0]?.path || null;
    selectedSessionId = null;
  }
}

export async function startHeartbeat() {
  stopHeartbeat();
  unlistenHeartbeat = await listen("heartbeat", onHeartbeat);
}

export function stopHeartbeat() {
  if (unlistenHeartbeat) {
    unlistenHeartbeat();
    unlistenHeartbeat = null;
  }
}

// ── Project / session selection ───────────────────────────────────

export function selectProject(path) {
  selectedProjectPath = path;
  selectedSessionId = null;
}

export function selectSession(id) {
  selectedSessionId = id;
}

// ── Terminal ──────────────────────────────────────────────────────

async function detachListeners() {
  if (unlistenOutput) { await unlistenOutput(); unlistenOutput = null; }
  if (unlistenExit) { await unlistenExit(); unlistenExit = null; }
}

async function stopTerminalSession() {
  if (!terminalSessionId) return;
  try { await invoke("close_terminal", { sessionId: terminalSessionId }); } catch {}
  terminalSessionId = null;
}

export async function runTerminal(terminal, projectPath, args, label) {
  await detachListeners();
  await stopTerminalSession();
  terminal.reset();
  terminalStatus = label;

  unlistenOutput = await listen("terminal-output", (event) => {
    if (event.payload.sessionId !== terminalSessionId) return;
    terminal.write(event.payload.data);
  });

  unlistenExit = await listen("terminal-exit", (event) => {
    if (event.payload.sessionId !== terminalSessionId) return;
    terminalStatus = `Exited${event.payload.code == null ? "" : ` (${event.payload.code})`}`;
    terminalSessionId = null;
  });

  terminalSessionId = await invoke("spawn_aimux", {
    project: projectPath,
    args,
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

export async function resizeTerminal(terminal) {
  if (!terminalSessionId) return;
  try {
    await invoke("resize_terminal", {
      sessionId: terminalSessionId,
      cols: terminal.cols,
      rows: terminal.rows,
    });
  } catch {}
}

export async function writeTerminal(data) {
  if (!terminalSessionId) return;
  await invoke("write_terminal", { sessionId: terminalSessionId, data });
}
