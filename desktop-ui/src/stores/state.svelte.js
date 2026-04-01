import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Reactive state ────────────────────────────────────────────────

let projects = $state([]);
let selectedProjectPath = $state(null);
let selectedSessionId = $state(null);
let terminalSessionId = $state(null);
let terminalStatus = $state("Idle");

let worktreeCache = $state({}); // projectPath → worktree[]

let unlistenOutput = null;
let unlistenExit = null;
let heartbeatTimer = null;
let ensuringHosts = new Set();
let heartbeatInFlight = false;
let heartbeatCount = 0;

function scoreStatusline(statusline) {
  if (!statusline) return 0;
  const sessions = statusline.sessions?.length ?? 0;
  const metadata = statusline.metadata ? Object.keys(statusline.metadata).length : 0;
  const tasks = (statusline.tasks?.pending || 0) + (statusline.tasks?.assigned || 0);
  return sessions * 100 + metadata * 10 + tasks;
}

function mergeProjects(existing, incoming) {
  const incomingByPath = new Map(incoming.map((project) => [project.path, project]));
  const merged = [];

  for (const current of existing) {
    const next = incomingByPath.get(current.path);
    if (!next) {
      merged.push(current);
      continue;
    }

    const currentScore = scoreStatusline(current.statusline);
    const nextScore = scoreStatusline(next.statusline);
    merged.push({
      ...next,
      statusline: nextScore >= currentScore ? next.statusline : current.statusline,
    });
    incomingByPath.delete(current.path);
  }

  for (const next of incomingByPath.values()) {
    merged.push(next);
  }

  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

export function getState() {
  return {
    get projects() { return projects; },
    get selectedProjectPath() { return selectedProjectPath; },
    set selectedProjectPath(v) { selectedProjectPath = v; },
    get selectedSessionId() { return selectedSessionId; },
    set selectedSessionId(v) { selectedSessionId = v; },
    get terminalSessionId() { return terminalSessionId; },
    get terminalStatus() { return terminalStatus; },
    get selectedProject() {
      return projects.find((p) => p.path === selectedProjectPath) || null;
    },
    get statusline() {
      const project = projects.find((p) => p.path === selectedProjectPath);
      return project?.statusline || null;
    },
    get worktreeList() {
      return worktreeCache[selectedProjectPath] || [];
    },
  };
}

export async function refreshWorktrees(projectPath) {
  if (!projectPath) return;
  try {
    const result = await invoke("worktree_list", { projectPath });
    worktreeCache[projectPath] = Array.isArray(result) ? result : [];
  } catch {
    // worktree list not available — ignore
  }
}

// ── Heartbeat (single loop for everything) ────────────────────────

async function tick() {
  if (heartbeatInFlight) return;
  heartbeatInFlight = true;
  try {
    const response = await invoke("heartbeat");
    const incoming = response.projects || [];

    incoming.sort((a, b) => a.name.localeCompare(b.name));
    projects = mergeProjects(projects, incoming);

    // Auto-select first project if none selected
    if (!selectedProjectPath && projects.length > 0) {
      selectedProjectPath = projects[0].path;
    }
    // Fix stale selection
    if (selectedProjectPath && !projects.some((p) => p.path === selectedProjectPath)) {
      selectedProjectPath = projects[0]?.path || null;
      selectedSessionId = null;
    }

    // Auto-ensure host only for real projects (those with a real path on disk)
    for (const project of projects) {
      if (!project.serviceAlive && !ensuringHosts.has(project.path) && project.path.startsWith("/")) {
        ensuringHosts.add(project.path);
        invoke("ensure_daemon_project", { projectPath: project.path })
          .catch(() => {}) // Silently ignore — may be a stale registry entry
          .finally(() => ensuringHosts.delete(project.path));
      }
    }
    // Refresh worktree list periodically (~every 15s)
    heartbeatCount++;
    if (heartbeatCount % 5 === 1 && selectedProjectPath) {
      refreshWorktrees(selectedProjectPath);
    }
  } catch (error) {
    console.error("Heartbeat failed:", error);
  } finally {
    heartbeatInFlight = false;
  }
}

export function startHeartbeat() {
  stopHeartbeat();
  tick();
  heartbeatTimer = setInterval(tick, 3000);
}

export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── Project / session selection ───────────────────────────────────

export function selectProject(path) {
  selectedProjectPath = path;
  selectedSessionId = null;
  refreshWorktrees(path);
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
