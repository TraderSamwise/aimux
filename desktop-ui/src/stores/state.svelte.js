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
let heartbeatTimer = null;
let ensuringHosts = new Set();

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
  };
}

// Fingerprint only the fields the UI renders — ignores updatedAt, logs, etc.
function uiFingerprint(project) {
  const sl = project.statusline;
  if (!sl) return "null";
  const sessions = (sl.sessions ?? []).map((s) => `${s.id}:${s.status}:${s.role || ""}`).join(",");
  const meta = sl.metadata ? Object.entries(sl.metadata).map(([id, m]) => {
    const d = m.derived || {};
    return `${id}:${d.activity || ""}:${d.attention || ""}:${d.unseenCount ?? 0}`;
  }).join(",") : "";
  const tasks = sl.tasks ? `${sl.tasks.pending || 0}:${sl.tasks.assigned || 0}` : "";
  return `${sessions}|${meta}|${tasks}|${sl.flash || ""}|${sl.dashboardScreen || ""}`;
}

// ── Heartbeat (single loop for everything) ────────────────────────

async function tick() {
  try {
    const response = await invoke("heartbeat");
    const incoming = response.projects || [];

    // Sort alphabetically for stable ordering
    incoming.sort((a, b) => a.name.localeCompare(b.name));

    // Build a stable project set — only add new projects, never remove existing
    // ones mid-session (protects against mid-write reads of projects.json).
    const incomingById = new Map(incoming.map((p) => [p.id, p]));
    const existingById = new Map(projects.map((p) => [p.id, p]));

    let changed = false;
    const merged = [];

    // Keep all existing projects, update their data if incoming has fresher info
    for (const existing of projects) {
      const fresh = incomingById.get(existing.id);
      if (fresh) {
        const currFp = uiFingerprint(existing);
        const nextFp = uiFingerprint(fresh);
        if (existing.serviceAlive !== fresh.serviceAlive || currFp !== nextFp) {
          merged.push(fresh);
          changed = true;
        } else {
          merged.push(existing);
        }
      } else {
        // Project disappeared from registry — keep it (likely mid-write)
        merged.push(existing);
      }
    }

    // Add genuinely new projects
    for (const fresh of incoming) {
      if (!existingById.has(fresh.id)) {
        merged.push(fresh);
        changed = true;
      }
    }

    // Sort alphabetically for stable ordering
    merged.sort((a, b) => a.name.localeCompare(b.name));

    if (changed || projects.length === 0) {
      projects = merged;
    }

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
  } catch (error) {
    console.error("Heartbeat failed:", error);
  }
}

export function startHeartbeat() {
  stopHeartbeat();
  tick();
  heartbeatTimer = setInterval(tick, 2000);
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
