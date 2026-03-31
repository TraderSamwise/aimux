import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Reactive state using Svelte 5 runes
let projects = $state([]);
let selectedProjectPath = $state(null);
let selectedSessionId = $state(null);
let terminalSessionId = $state(null);
let terminalStatus = $state("Idle");
let loading = $state(false);
let statusline = $state(null);

let unlistenOutput = null;
let unlistenExit = null;
let statuslinePollTimer = null;

export function getState() {
  return {
    get projects() { return projects; },
    get selectedProjectPath() { return selectedProjectPath; },
    set selectedProjectPath(v) { selectedProjectPath = v; },
    get selectedSessionId() { return selectedSessionId; },
    set selectedSessionId(v) { selectedSessionId = v; },
    get terminalSessionId() { return terminalSessionId; },
    get terminalStatus() { return terminalStatus; },
    get loading() { return loading; },
    get statusline() { return statusline; },
    get selectedProject() {
      return projects.find((p) => p.path === selectedProjectPath) || null;
    },
  };
}

export async function loadProjects() {
  loading = true;
  try {
    const response = await invoke("list_projects");
    projects = response.projects || [];
    if (!selectedProjectPath && projects.length > 0) {
      selectedProjectPath = projects[0].path;
    }
    if (selectedProjectPath && !projects.some((p) => p.path === selectedProjectPath)) {
      selectedProjectPath = projects[0]?.path || null;
      selectedSessionId = null;
    }
  } catch (error) {
    console.error("Failed to load projects:", error);
    projects = [];
  } finally {
    loading = false;
  }
}

export function selectProject(path) {
  selectedProjectPath = path;
  selectedSessionId = null;
  statusline = null;
  pollStatusline();
}

export function selectSession(id) {
  selectedSessionId = id;
}

// --- Statusline polling ---

async function fetchStatusline() {
  const project = projects.find((p) => p.path === selectedProjectPath);
  if (!project) { statusline = null; return; }
  try {
    statusline = await invoke("read_statusline", { projectId: project.id });
  } catch {
    statusline = null;
  }
}

export function pollStatusline() {
  stopPollingStatusline();
  fetchStatusline();
  statuslinePollTimer = setInterval(fetchStatusline, 1500);
}

export function stopPollingStatusline() {
  if (statuslinePollTimer) {
    clearInterval(statuslinePollTimer);
    statuslinePollTimer = null;
  }
}

// --- Terminal ---

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
