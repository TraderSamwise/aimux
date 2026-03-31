import { Terminal } from "./vendor/xterm.mjs";
import { FitAddon } from "./vendor/addon-fit.mjs";
import { invoke } from "./vendor/tauri/core.js";
import { listen } from "./vendor/tauri/event.js";

const projectListEl = document.getElementById("project-list");
const sessionListEl = document.getElementById("session-list");
const projectTitleEl = document.getElementById("project-title");
const projectSubtitleEl = document.getElementById("project-subtitle");
const terminalStatusEl = document.getElementById("terminal-status");
const refreshButton = document.getElementById("refresh-projects");
const openDashboardButton = document.getElementById("open-dashboard");

const terminal = new Terminal({
  cursorBlink: true,
  scrollback: 5000,
  fontFamily: '"Iosevka Term", "SF Mono", Menlo, monospace',
  fontSize: 14,
  theme: {
    background: "#081018",
    foreground: "#e6edf3",
    cursor: "#7dd3fc",
    selectionBackground: "rgba(125, 211, 252, 0.25)",
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(document.getElementById("terminal"));
fitAddon.fit();

const state = {
  projects: [],
  selectedProjectPath: null,
  selectedSessionId: null,
  terminalSessionId: null,
  unlistenOutput: null,
  unlistenExit: null,
};

function badgeClass(status) {
  return `badge ${status || "idle"}`;
}

function setTerminalStatus(text) {
  terminalStatusEl.textContent = text;
}

function getSelectedProject() {
  return state.projects.find((project) => project.path === state.selectedProjectPath) || null;
}

function renderProjects() {
  projectListEl.innerHTML = "";
  if (state.projects.length === 0) {
    projectListEl.innerHTML = '<div class="empty-state">No aimux projects found.</div>';
    return;
  }

  for (const project of state.projects) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `project-card${project.path === state.selectedProjectPath ? " is-active" : ""}`;
    const liveCount = project.sessions.filter((session) => session.status !== "offline").length;
    card.innerHTML = `
      <div class="project-name">${project.name}</div>
      <div class="project-meta">${project.path}</div>
      <div class="badge-row">
        <span class="${badgeClass(liveCount > 0 ? "running" : "idle")}">${liveCount > 0 ? `${liveCount} live` : "idle"}</span>
        <span class="${badgeClass(project.serverRunning ? "running" : "offline")}">${project.serverRunning ? "server" : "no server"}</span>
      </div>
    `;
    card.addEventListener("click", () => {
      state.selectedProjectPath = project.path;
      state.selectedSessionId = null;
      render();
    });
    projectListEl.appendChild(card);
  }
}

function renderSessions() {
  const project = getSelectedProject();
  openDashboardButton.disabled = !project;
  if (!project) {
    projectTitleEl.textContent = "Select a project";
    projectSubtitleEl.textContent = "No project selected.";
    sessionListEl.className = "session-list empty-state";
    sessionListEl.textContent = "Select a project to view sessions.";
    return;
  }

  projectTitleEl.textContent = project.name;
  projectSubtitleEl.textContent = `${project.sessions.length} known session${project.sessions.length === 1 ? "" : "s"} in ${project.path}`;

  if (project.sessions.length === 0) {
    sessionListEl.className = "session-list empty-state";
    sessionListEl.textContent = "No known sessions for this project yet.";
    return;
  }

  sessionListEl.className = "session-list";
  sessionListEl.innerHTML = "";
  for (const session of project.sessions) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `session-card${session.id === state.selectedSessionId ? " is-active" : ""}`;
    card.innerHTML = `
      <div class="session-name">${session.label || session.id}</div>
      <div class="session-meta">${session.tool}${session.role ? ` · ${session.role}` : ""}${session.headline ? ` · ${session.headline}` : ""}</div>
      <div class="badge-row">
        <span class="${badgeClass(session.status)}">${session.status}</span>
        ${session.isServer ? '<span class="badge running">server-owned</span>' : ""}
      </div>
    `;
    card.addEventListener("click", async () => {
      state.selectedSessionId = session.id;
      render();
      await focusSession(project, session);
    });
    sessionListEl.appendChild(card);
  }
}

function render() {
  renderProjects();
  renderSessions();
}

async function detachListeners() {
  if (state.unlistenOutput) {
    await state.unlistenOutput();
    state.unlistenOutput = null;
  }
  if (state.unlistenExit) {
    await state.unlistenExit();
    state.unlistenExit = null;
  }
}

async function stopTerminalSession() {
  if (!state.terminalSessionId) return;
  try {
    await invoke("close_terminal", { sessionId: state.terminalSessionId });
  } catch {}
  state.terminalSessionId = null;
}

async function resizeTerminal() {
  fitAddon.fit();
  if (!state.terminalSessionId) return;
  try {
    await invoke("resize_terminal", {
      sessionId: state.terminalSessionId,
      cols: terminal.cols,
      rows: terminal.rows,
    });
  } catch {}
}

async function runTerminal(projectPath, args, label) {
  await detachListeners();
  await stopTerminalSession();
  terminal.reset();
  setTerminalStatus(label);

  state.unlistenOutput = await listen("terminal-output", (event) => {
    if (event.payload.sessionId !== state.terminalSessionId) return;
    terminal.write(event.payload.data);
  });

  state.unlistenExit = await listen("terminal-exit", (event) => {
    if (event.payload.sessionId !== state.terminalSessionId) return;
    setTerminalStatus(`Exited${event.payload.code === null ? "" : ` (${event.payload.code})`}`);
    state.terminalSessionId = null;
  });

  state.terminalSessionId = await invoke("spawn_aimux", {
    project: projectPath,
    args,
    cols: terminal.cols,
    rows: terminal.rows,
  });
  await resizeTerminal();
}

async function openDashboard(project) {
  await runTerminal(project.path, ["desktop", "open", "--project", project.path], `Dashboard · ${project.name}`);
}

async function focusSession(project, session) {
  await runTerminal(
    project.path,
    ["desktop", "focus", "--project", project.path, "--session", session.id],
    `Session · ${session.label || session.id}`,
  );
}

async function loadProjects() {
  refreshButton.disabled = true;
  try {
    const response = await invoke("list_projects");
    state.projects = response.projects || [];
    if (!state.selectedProjectPath && state.projects.length > 0) {
      state.selectedProjectPath = state.projects[0].path;
    }
    if (state.selectedProjectPath && !state.projects.some((project) => project.path === state.selectedProjectPath)) {
      state.selectedProjectPath = state.projects[0]?.path || null;
      state.selectedSessionId = null;
    }
    render();
  } catch (error) {
    console.error(error);
    projectListEl.innerHTML = `<div class="empty-state">Failed to load projects.</div>`;
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => {
  void loadProjects();
});

openDashboardButton.addEventListener("click", () => {
  const project = getSelectedProject();
  if (!project) return;
  void openDashboard(project);
});

window.addEventListener("resize", () => {
  void resizeTerminal();
});

terminal.onData((data) => {
  if (!state.terminalSessionId) return;
  void invoke("write_terminal", { sessionId: state.terminalSessionId, data });
});

terminal.writeln("Aimux Desktop Shell");
terminal.writeln("");
terminal.writeln("Select a project, then open the dashboard or focus a live session.");
setTerminalStatus("Idle");

void loadProjects();
