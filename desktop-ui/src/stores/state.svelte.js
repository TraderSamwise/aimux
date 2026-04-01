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

// ── In-progress action queue ──────────────────────────────────────

let tickNumber = $state(0);
let pendingActions = $state([]);
let currentAction = $state(null);

export function pushAction(message) {
  pendingActions.push({ message, tickCreated: tickNumber });
  currentAction = message;
}

function drainActions() {
  const cutoff = tickNumber - 2;
  pendingActions = pendingActions.filter((a) => a.tickCreated > cutoff);
  currentAction = pendingActions.length > 0
    ? pendingActions[pendingActions.length - 1].message
    : null;
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
    get selectedProject() {
      return projects.find((p) => p.path === selectedProjectPath) || null;
    },
    get statusline() {
      const project = projects.find((p) => p.path === selectedProjectPath);
      return project?.statusline || null;
    },
    get daemonSessions() {
      const project = projects.find((p) => p.path === selectedProjectPath);
      return project?.sessions || [];
    },
    get worktreeList() {
      const project = projects.find((p) => p.path === selectedProjectPath);
      return project?.worktrees || [];
    },
  };
}

// ── Heartbeat listener (Rust pushes events, JS just receives) ─────

function onHeartbeat(event) {
  tickNumber++;
  drainActions();

  const incoming = event.payload?.projects || [];
  incoming.sort((a, b) => a.name.localeCompare(b.name));
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
