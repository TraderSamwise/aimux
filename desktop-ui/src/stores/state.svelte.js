import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Reactive state ────────────────────────────────────────────────

let projects = $state([]);
let selectedProjectPath = $state(null);
let selectedSessionId = $state(null);
let selectedScreen = $state("dashboard");
let interactionMode = $state("terminal");
let terminalSessionId = $state(null);
let terminalStatus = $state("Idle");
let terminalProjectPath = $state(null);
let nativeChatOutput = $state("");
let nativeChatBlocks = $state([]);
let nativeChatLoading = $state(false);
let nativeChatError = $state(null);
let nativeChatProjectPath = $state(null);
let nativeChatSessionId = $state(null);
let nativeChatRawMode = $state(false);
let nativeChatDrafts = $state({});

let unlistenOutput = null;
let unlistenExit = null;
let unlistenHeartbeat = null;
let nativeChatPollTimer = null;
let nativeChatPollToken = 0;
let nativeChatPollInFlight = false;

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
      continue;
    }

    if (action.kind === "fork" && action.sessionId) {
      if ((project.sessions || []).some((session) => session.id === action.sessionId)) {
        finished.push(action.key);
      }
      continue;
    }

    if (action.kind === "rename" && action.sessionId) {
      const session = (project.sessions || []).find((entry) => entry.id === action.sessionId);
      if (!session) continue;
      const nextLabel = action.label?.trim() || null;
      const currentLabel = session.label?.trim() || null;
      if (currentLabel === nextLabel) {
        finished.push(action.key);
      }
      continue;
    }

    if (action.kind === "migrate" && action.sessionId && action.worktreePath) {
      const session = (project.sessions || []).find((entry) => entry.id === action.sessionId);
      if (!session) continue;
      if ((session.worktreePath || null) === action.worktreePath) {
        finished.push(action.key);
      }
      continue;
    }

    if (action.kind === "resurrect" && action.sessionId) {
      const session = (project.sessions || []).find((entry) => entry.id === action.sessionId);
      if (session?.status === "offline") {
        finished.push(action.key);
      }
      continue;
    }

    if (action.kind === "remove-worktree" && action.worktreePath) {
      const exists = (project.worktrees || []).some((worktree) => worktree.path === action.worktreePath);
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

    if (action.kind === "fork") {
      const pendingId = `pending-fork:${action.key}`;
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

    if (action.kind === "rename" && action.sessionId) {
      next.sessions = next.sessions.map((session) =>
        session.id === action.sessionId
          ? {
              ...session,
              label: action.label,
              pending: true,
              pendingAction: action.kind,
            }
          : session
      );
      if (next.statusline) {
        next.statusline.sessions = next.statusline.sessions.map((session) =>
          session.id === action.sessionId
            ? {
                ...session,
                label: action.label,
                pending: true,
                pendingAction: action.kind,
              }
            : session
        );
      }
    }

    if (action.kind === "migrate" && action.sessionId) {
      next.sessions = next.sessions.map((session) =>
        session.id === action.sessionId
          ? {
              ...session,
              pending: true,
              pendingAction: action.kind,
              status: "migrating",
              worktreePath: action.worktreePath || session.worktreePath || null,
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
                status: "migrating",
                worktreePath: action.worktreePath || session.worktreePath || null,
              }
            : session
        );
      }
    }

    if (action.kind === "resurrect") {
      const pendingSession = {
        id: action.sessionId,
        tool: action.tool,
        label: action.label || action.tool || action.sessionId,
        role: action.role,
        status: "offline",
        pending: true,
        worktreePath: action.worktreePath || null,
      };
      if (!next.sessions.some((session) => session.id === action.sessionId)) {
        next.sessions = [pendingSession, ...next.sessions];
      }
      if (next.statusline && !next.statusline.sessions.some((session) => session.id === action.sessionId)) {
        next.statusline.sessions = [pendingSession, ...next.statusline.sessions];
      }
    }

    if (action.kind === "remove-worktree" && action.worktreePath) {
      next.worktrees = next.worktrees.map((worktree) =>
        worktree.path === action.worktreePath
          ? {
              ...worktree,
              pending: true,
              removing: true,
            }
          : worktree
      );
    }
  }

  return next;
}

function splitTranscriptBlocks(output) {
  const lines = String(output || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let current = null;
  let sawPrompt = false;
  let expectingResponse = false;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n").trimEnd();
    if (text) blocks.push({ type: current.type, text });
    current = null;
  };

  const pushLine = (type, line) => {
    if (!current || current.type !== type) {
      flush();
      current = { type, lines: [] };
    }
    current.lines.push(line);
  };

  const isDivider = (line) => {
    const trimmed = line.trim();
    return Boolean(trimmed) && /^[\u2500-\u257f\-_=\s]+$/.test(trimmed);
  };

  const isPathLike = (line) => /(^~\/|^\/|^[A-Za-z]:\\)/.test(line.trim());
  const isClaudePreludeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return current?.type === "meta";
    return (
      trimmed.includes("Claude Code") ||
      trimmed.includes("Claude Max") ||
      trimmed.includes("Sonnet") ||
      trimmed.includes("Opus") ||
      (isPathLike(trimmed) && !sawPrompt) ||
      (/context\)/.test(trimmed) && !sawPrompt)
    );
  };
  const isFooterLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return (
      /^([A-Za-z0-9._-]+@[^ ]+|~\/|\/)/.test(trimmed) && /(context\)|%\s|[$#]\s)/.test(trimmed) ||
      /^([›>]|▶)\s/.test(trimmed) && /(permissions|cycle|cwd|context)/i.test(trimmed) ||
      /gpt-|claude|context\)|bypass permissions|shift\+tab|to cycle/i.test(trimmed)
    );
  };
  const isStatusLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return (
      /^■\s?/.test(trimmed) ||
      /^•\s?Working\b/.test(trimmed) ||
      /Conversation interrupted/i.test(trimmed) ||
      /\bWorking \(\d+s/.test(trimmed)
    );
  };
  const isPromptLine = (line) => {
    const trimmed = line.trimStart();
    if (/^›\s?/.test(trimmed)) return true;
    if (/^>\s?/.test(trimmed)) return true;
    return false;
  };
  const stripPromptMarker = (line) => line.trimStart().replace(/^(›|>)\s?/, "");
  const stripResponseMarker = (line) => line.trimStart().replace(/^•\s?/, "");
  const stripStatusMarker = (line) => line.trimStart().replace(/^■\s?/, "");

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (isDivider(trimmed)) {
      continue;
    }
    if (isPromptLine(trimmed)) {
      pushLine("prompt", stripPromptMarker(trimmed));
      sawPrompt = true;
      expectingResponse = true;
      continue;
    }
    if (/^•\s?/.test(trimmed) && !/^•\s?Working\b/.test(trimmed)) {
      pushLine("response", stripResponseMarker(trimmed));
      sawPrompt = true;
      expectingResponse = false;
      continue;
    }
    if (isStatusLine(trimmed)) {
      pushLine("status", stripStatusMarker(trimmed));
      expectingResponse = false;
      continue;
    }
    if (!sawPrompt && isClaudePreludeLine(trimmed)) {
      pushLine("meta", trimmed);
      continue;
    }
    if (isFooterLine(trimmed)) {
      pushLine("status", trimmed);
      expectingResponse = false;
      continue;
    }
    if (!trimmed.trim()) {
      if (current && current.type !== "raw") {
        current.lines.push("");
        continue;
      }
      flush();
      continue;
    }
    if (expectingResponse || current?.type === "response") {
      pushLine("response", trimmed);
      continue;
    }
    if (current?.type === "meta" && isClaudePreludeLine(trimmed)) {
      current.lines.push(trimmed);
      continue;
    }
    if (current?.type === "status") {
      current.lines.push(trimmed);
      continue;
    }
    pushLine("raw", trimmed);
  }

  flush();
  return blocks.filter((block) => block.text.trim().length > 0);
}

function setNativeChatSnapshot(projectPath, sessionId, output) {
  nativeChatProjectPath = projectPath;
  nativeChatSessionId = sessionId;
  nativeChatOutput = output;
  nativeChatBlocks = splitTranscriptBlocks(output);
  nativeChatError = null;
}

function beginNativeChatSelection(projectPath, sessionId) {
  nativeChatProjectPath = projectPath;
  nativeChatSessionId = sessionId;
  nativeChatOutput = "";
  nativeChatBlocks = [];
  nativeChatLoading = true;
  nativeChatError = null;
}

function clearNativeChatSnapshot() {
  nativeChatProjectPath = null;
  nativeChatSessionId = null;
  nativeChatOutput = "";
  nativeChatBlocks = [];
  nativeChatLoading = false;
  nativeChatError = null;
}

function stopNativeChatPolling({ clear = false } = {}) {
  nativeChatPollToken += 1;
  nativeChatPollInFlight = false;
  if (nativeChatPollTimer) {
    clearTimeout(nativeChatPollTimer);
    nativeChatPollTimer = null;
  }
  nativeChatLoading = false;
  if (clear) clearNativeChatSnapshot();
}

async function pollNativeChat(projectPath, sessionId, token, delayMs = 0) {
  if (nativeChatPollTimer) {
    clearTimeout(nativeChatPollTimer);
    nativeChatPollTimer = null;
  }

  nativeChatPollTimer = setTimeout(async () => {
    if (token !== nativeChatPollToken) return;
    if (nativeChatPollInFlight) return;

    nativeChatPollInFlight = true;
    try {
      const result = await invoke("agent_read", {
        projectPath,
        sessionId,
        startLine: -120,
      });
      if (token !== nativeChatPollToken) return;
      setNativeChatSnapshot(projectPath, sessionId, result?.output ?? "");
      nativeChatLoading = false;
    } catch (error) {
      if (token !== nativeChatPollToken) return;
      nativeChatError = String(error);
      nativeChatLoading = false;
    } finally {
      nativeChatPollInFlight = false;
      if (token === nativeChatPollToken) {
        void pollNativeChat(projectPath, sessionId, token, 750);
      }
    }
  }, delayMs);
}

function syncNativeChatSelection() {
  if (interactionMode !== "native-chat") {
    stopNativeChatPolling();
    return;
  }
  if (!selectedProjectPath || !selectedSessionId) {
    stopNativeChatPolling({ clear: true });
    return;
  }

  beginNativeChatSelection(selectedProjectPath, selectedSessionId);
  nativeChatPollToken += 1;
  const token = nativeChatPollToken;
  void pollNativeChat(selectedProjectPath, selectedSessionId, token, 0);
}

// ── State getters ─────────────────────────────────────────────────

export function getState() {
  return {
    get projects() { return projects; },
    get selectedProjectPath() { return selectedProjectPath; },
    set selectedProjectPath(v) { selectedProjectPath = v; },
    get selectedSessionId() { return selectedSessionId; },
    set selectedSessionId(v) { selectedSessionId = v; },
    get selectedScreen() { return selectedScreen; },
    set selectedScreen(v) { selectedScreen = v; },
    get interactionMode() { return interactionMode; },
    set interactionMode(v) { interactionMode = v; },
    get terminalSessionId() { return terminalSessionId; },
    get terminalStatus() { return terminalStatus; },
    get currentAction() { return currentAction; },
    get inFlightActions() { return inFlightActions; },
    get nativeChatOutput() { return nativeChatOutput; },
    get nativeChatBlocks() { return nativeChatBlocks; },
    get nativeChatLoading() { return nativeChatLoading; },
    get nativeChatError() { return nativeChatError; },
    get nativeChatProjectPath() { return nativeChatProjectPath; },
    get nativeChatSessionId() { return nativeChatSessionId; },
    get nativeChatRawMode() { return nativeChatRawMode; },
    set nativeChatRawMode(v) { nativeChatRawMode = v; },
    get nativeChatDraft() { return selectedSessionId ? nativeChatDrafts[selectedSessionId] || "" : ""; },
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

  if (selectedProjectPath && selectedSessionId) {
    const selectedProject = projects.find((project) => project.path === selectedProjectPath);
    const sessionStillExists = (selectedProject?.sessions || []).some((session) => session.id === selectedSessionId);
    if (!sessionStillExists) {
      selectedSessionId = null;
      stopNativeChatPolling({ clear: true });
    }
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

export async function selectProject(path) {
  if (terminalProjectPath && terminalProjectPath !== path) {
    await detachListeners();
    await stopTerminalSession();
  }
  selectedProjectPath = path;
  selectedSessionId = null;
  stopNativeChatPolling({ clear: true });
}

export function selectSession(id) {
  selectedSessionId = id;
  syncNativeChatSelection();
}

export function selectScreen(screen) {
  selectedScreen = screen;
}

export function selectInteractionMode(mode) {
  interactionMode = mode === "native-chat" ? "native-chat" : "terminal";
  syncNativeChatSelection();
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
  terminalProjectPath = null;
}

export async function runTerminal(terminal, projectPath, args, label) {
  await detachListeners();
  await stopTerminalSession();
  terminal.reset();
  terminalStatus = label;
  terminalProjectPath = projectPath;

  unlistenOutput = await listen("terminal-output", (event) => {
    if (event.payload.sessionId !== terminalSessionId) return;
    terminal.write(event.payload.data);
  });

  unlistenExit = await listen("terminal-exit", (event) => {
    if (event.payload.sessionId !== terminalSessionId) return;
    terminalStatus = `Exited${event.payload.code == null ? "" : ` (${event.payload.code})`}`;
    terminalSessionId = null;
    terminalProjectPath = null;
  });

  terminalSessionId = await invoke("spawn_aimux", {
    project: projectPath,
    args,
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

export async function focusTerminalAgent(terminal, projectPath, sessionId, label) {
  terminalStatus = label;
  if (terminalSessionId && terminalProjectPath === projectPath) {
    try {
      await invoke("focus_terminal_agent", {
        sessionId: terminalSessionId,
        projectPath,
        agentId: sessionId,
      });
      return;
    } catch {}
  }

  await runTerminal(
    terminal,
    projectPath,
    ["desktop", "focus", "--project", projectPath, "--session", sessionId],
    label,
  );
}

export async function openSession(terminal, projectPath, sessionId, label) {
  selectSession(sessionId);
  selectedScreen = "dashboard";
  if (interactionMode === "native-chat") {
    return;
  }
  if (!terminal) return;
  await focusTerminalAgent(terminal, projectPath, sessionId, label);
}

export async function openTerminalDashboard(terminal, projectPath, label) {
  terminalStatus = label;
  if (terminalSessionId && terminalProjectPath === projectPath) {
    try {
      await invoke("focus_terminal_dashboard", {
        sessionId: terminalSessionId,
        projectPath,
      });
      return;
    } catch {}
  }

  await runTerminal(
    terminal,
    projectPath,
    ["desktop", "open", "--project", projectPath],
    label,
  );
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

export function setNativeChatDraft(value) {
  if (!selectedSessionId) return;
  nativeChatDrafts = {
    ...nativeChatDrafts,
    [selectedSessionId]: value,
  };
}

export async function sendNativeChatMessage() {
  const projectPath = selectedProjectPath;
  const sessionId = selectedSessionId;
  const draft = sessionId ? nativeChatDrafts[sessionId] || "" : "";
  if (!projectPath || !sessionId || !draft.trim()) return;

  await trackAction(
    {
      kind: "agent-send",
      message: `Sending to ${sessionId}...`,
      projectPath,
      sessionId,
    },
    () =>
      invoke("agent_send", {
        projectPath,
        sessionId,
        data: draft,
        submit: true,
      }),
  );

  nativeChatDrafts = {
    ...nativeChatDrafts,
    [sessionId]: "",
  };
  syncNativeChatSelection();
}
