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
let nativeChatHistory = $state([]);
let nativeChatLoading = $state(false);
let nativeChatError = $state(null);
let nativeChatComposerError = $state(null);
let nativeChatProjectPath = $state(null);
let nativeChatSessionId = $state(null);
let nativeChatRawMode = $state(false);
let nativeChatDraftParts = $state({});
let currentAlert = $state(null);
let recentAlerts = $state([]);
let expectedServiceInfo = $state(null);
let controlPlaneError = $state(null);

let unlistenOutput = null;
let unlistenExit = null;
let unlistenHeartbeat = null;
let nativeChatHistoryTimer = null;
let nativeChatReconnectTimer = null;
let nativeChatResyncTimer = null;
let nativeChatStream = null;
let nativeChatStreamToken = 0;
let nativeChatHistoryInFlight = false;
let alertDismissTimer = null;
let heartbeatTicker = $state(Date.now());
let lastHeartbeatAt = $state(0);
let heartbeatInterval = null;
const projectAlertStreams = new Map();
let lastControlPlaneSignature = null;
let lastControlPlaneSnapshot = null;
let lastOverlayInputProject = null;
let lastOverlaySignature = null;
let lastOverlayResult = null;

// ── In-progress actions ───────────────────────────────────────────

let inFlightActions = $state([]);
let currentAction = $state(null);

const REQUIRED_PROJECT_SERVICE_CAPABILITIES = ["structuredAgentInput", "parsedAgentOutput", "attachments", "agentHistory", "chatEventStream"];
const REQUIRED_PROJECT_SERVICE_API_VERSION = 4;

function syncCurrentAction() {
  currentAction = inFlightActions.length > 0
    ? inFlightActions[inFlightActions.length - 1].message
    : null;
}

function pushAlert(event) {
  const next = {
    key: `${event.projectId}:${event.sessionId || "project"}:${event.kind}:${event.ts}`,
    receivedAt: Date.now(),
    ...event,
  };
  currentAlert = next;
  recentAlerts = [...recentAlerts.filter((entry) => entry.key !== next.key), next].slice(-20);
  if (alertDismissTimer) {
    clearTimeout(alertDismissTimer);
  }
  alertDismissTimer = setTimeout(() => {
    if (currentAlert?.key === next.key) {
      currentAlert = null;
    }
  }, 8000);
}

function stopProjectAlertStream(projectPath) {
  const existing = projectAlertStreams.get(projectPath);
  if (existing) {
    existing.close();
    projectAlertStreams.delete(projectPath);
  }
}

function syncProjectAlertStreams(nextProjects = projects) {
  if (typeof EventSource === "undefined") return;

  const desired = new Map(
    nextProjects
      .filter((project) => project?.serviceEndpointAlive && project?.serviceEndpoint?.host && project?.serviceEndpoint?.port)
      .map((project) => [
        project.path,
        `http://${project.serviceEndpoint.host}:${project.serviceEndpoint.port}/events`,
      ])
  );

  for (const [projectPath] of projectAlertStreams) {
    if (!desired.has(projectPath)) {
      stopProjectAlertStream(projectPath);
    }
  }

  for (const [projectPath, url] of desired) {
    const existing = projectAlertStreams.get(projectPath);
    if (existing?.url === url) continue;
    stopProjectAlertStream(projectPath);

    const stream = new EventSource(url);
    stream.addEventListener("alert", (event) => {
      try {
        pushAlert(JSON.parse(event.data || "{}"));
      } catch {}
    });
    stream.addEventListener("error", () => {});
    projectAlertStreams.set(projectPath, {
      url,
      close: () => stream.close(),
    });
  }
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

function getProjectServiceInfo(project) {
  return project?.serviceInfo || null;
}

function getMissingProjectServiceCapabilities(project) {
  const capabilities = getProjectServiceInfo(project)?.capabilities || {};
  return REQUIRED_PROJECT_SERVICE_CAPABILITIES.filter((key) => capabilities[key] !== true);
}

function manifestsMatch(expected, actual) {
  if (!expected || !actual) return false;
  if (Number(actual.apiVersion || 0) !== Number(expected.apiVersion || 0)) return false;
  if (String(actual.buildStamp || "") !== String(expected.buildStamp || "")) return false;
  const expectedCapabilities = expected.capabilities || {};
  const actualCapabilities = actual.capabilities || {};
  return Object.entries(expectedCapabilities).every(([key, value]) => actualCapabilities[key] === value);
}

function buildControlPlaneSnapshot(project) {
  const heartbeatAgeMs = lastHeartbeatAt > 0 ? Math.max(0, heartbeatTicker - lastHeartbeatAt) : Number.POSITIVE_INFINITY;
  const daemonConnected = heartbeatAgeMs < 5000;
  const serviceInfo = getProjectServiceInfo(project);
  const missingCapabilities = getMissingProjectServiceCapabilities(project);
  const manifestMatches = manifestsMatch(expectedServiceInfo, serviceInfo);
  const buildMismatch =
    Boolean(project?.serviceEndpointAlive) &&
    Boolean(expectedServiceInfo?.buildStamp) &&
    Boolean(serviceInfo?.buildStamp) &&
    !manifestMatches;
  const serviceOutdated =
    Boolean(project?.serviceEndpointAlive) &&
    (
      !serviceInfo ||
      Number(serviceInfo.apiVersion || 0) < REQUIRED_PROJECT_SERVICE_API_VERSION ||
      missingCapabilities.length > 0 ||
      buildMismatch
    );
  const daemonStatus = daemonConnected ? "ok" : "down";
  const projectStatus =
    !project
      ? "unselected"
      : serviceOutdated
        ? "outdated"
        : project?.serviceEndpointAlive === false
          ? "degraded"
          : project?.serviceAlive === false
            ? "degraded"
            : "ok";
  const reason =
    !daemonConnected
      ? "Daemon is disconnected."
      : buildMismatch
        ? "Project service build is stale for this desktop build."
        : !serviceInfo
          ? "Project service is missing manifest information."
          : Number(serviceInfo.apiVersion || 0) < REQUIRED_PROJECT_SERVICE_API_VERSION
            ? "Project service API version is outdated."
            : missingCapabilities.length > 0
              ? `Project service is missing capabilities: ${missingCapabilities.join(", ")}`
              : project?.serviceEndpointAlive === false
                ? "Project service endpoint is unreachable."
                : project?.serviceAlive === false
                  ? "Project service is not running."
                  : null;
  const status =
    !daemonConnected
      ? "down"
      : serviceOutdated
        ? "outdated"
        : project?.serviceEndpointAlive === false
          ? "degraded"
          : project?.serviceAlive === false
            ? "degraded"
            : "ok";

  const signature = JSON.stringify({
    projectPath: project?.path || null,
    heartbeatBucket: Number.isFinite(heartbeatAgeMs) ? Math.floor(heartbeatAgeMs / 1000) : "inf",
    daemonConnected,
    serviceAlive: Boolean(project?.serviceAlive),
    serviceEndpointAlive: Boolean(project?.serviceEndpointAlive),
    expectedBuildStamp: expectedServiceInfo?.buildStamp || null,
    actualBuildStamp: serviceInfo?.buildStamp || null,
    actualApiVersion: Number(serviceInfo?.apiVersion || 0),
    missingCapabilities,
    buildMismatch,
    daemonStatus,
    projectStatus,
    status,
    reason,
    error: controlPlaneError,
  });

  if (signature === lastControlPlaneSignature && lastControlPlaneSnapshot) {
    return lastControlPlaneSnapshot;
  }

  lastControlPlaneSignature = signature;
  lastControlPlaneSnapshot = {
    daemonConnected,
    heartbeatAgeMs,
    serviceAlive: Boolean(project?.serviceAlive),
    serviceEndpointAlive: Boolean(project?.serviceEndpointAlive),
    expectedServiceInfo,
    serviceInfo,
    buildMismatch,
    missingCapabilities,
    error: controlPlaneError,
    reason,
    daemonStatus,
    projectStatus,
    status,
  };
  return lastControlPlaneSnapshot;
}

function overlayActionSignature(project) {
  return JSON.stringify(
    inFlightActions
      .filter((action) => action.projectPath === project.path)
      .map((action) => ({
        key: action.key,
        kind: action.kind,
        phase: action.phase,
        sessionId: action.sessionId || null,
        worktreePath: action.worktreePath || null,
        label: action.label || null,
        tool: action.tool || null,
      })),
  );
}

function applyActionOverlays(project) {
  if (!project) return null;
  const signature = overlayActionSignature(project);
  if (project === lastOverlayInputProject && signature === lastOverlaySignature) {
    return lastOverlayResult;
  }

  const actions = inFlightActions.filter((action) => action.projectPath === project.path);
  if (actions.length === 0) {
    lastOverlayInputProject = project;
    lastOverlaySignature = signature;
    lastOverlayResult = project;
    return project;
  }

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

  lastOverlayInputProject = project;
  lastOverlaySignature = signature;
  lastOverlayResult = next;
  return next;
}

function setNativeChatSnapshot(projectPath, sessionId, snapshot) {
  nativeChatProjectPath = projectPath;
  nativeChatSessionId = sessionId;
  nativeChatOutput = String(snapshot?.output ?? "");
  nativeChatBlocks = Array.isArray(snapshot?.parsed?.blocks) ? snapshot.parsed.blocks : [];
  nativeChatHistory = Array.isArray(snapshot?.history?.messages) ? snapshot.history.messages : [];
  nativeChatError = null;
}

function beginNativeChatSelection(projectPath, sessionId, { preserveSnapshot = false } = {}) {
  nativeChatProjectPath = projectPath;
  nativeChatSessionId = sessionId;
  if (!preserveSnapshot) {
    nativeChatOutput = "";
    nativeChatBlocks = [];
    nativeChatHistory = [];
  }
  nativeChatLoading = true;
  nativeChatError = null;
}

function clearNativeChatSnapshot() {
  nativeChatProjectPath = null;
  nativeChatSessionId = null;
  nativeChatOutput = "";
  nativeChatBlocks = [];
  nativeChatHistory = [];
  nativeChatLoading = false;
  nativeChatError = null;
}

function stopNativeChatStreaming({ clear = false } = {}) {
  nativeChatStreamToken += 1;
  nativeChatHistoryInFlight = false;
  if (nativeChatHistoryTimer) {
    clearTimeout(nativeChatHistoryTimer);
    nativeChatHistoryTimer = null;
  }
  if (nativeChatReconnectTimer) {
    clearTimeout(nativeChatReconnectTimer);
    nativeChatReconnectTimer = null;
  }
  if (nativeChatResyncTimer) {
    clearInterval(nativeChatResyncTimer);
    nativeChatResyncTimer = null;
  }
  if (nativeChatStream) {
    nativeChatStream.close();
    nativeChatStream = null;
  }
  nativeChatLoading = false;
  if (clear) clearNativeChatSnapshot();
}

function startNativeChatResync(projectPath, sessionId, token, intervalMs = 1000) {
  if (nativeChatResyncTimer) {
    clearInterval(nativeChatResyncTimer);
    nativeChatResyncTimer = null;
  }
  nativeChatResyncTimer = setInterval(() => {
    if (token !== nativeChatStreamToken) return;
    void fetchNativeChatSnapshot(projectPath, sessionId, token);
  }, intervalMs);
}

async function refreshNativeChatHistory(projectPath, sessionId, token) {
  if (nativeChatHistoryInFlight) return;
  nativeChatHistoryInFlight = true;
  try {
    const history = await invoke("agent_history", {
      projectPath,
      sessionId,
      lastN: 20,
    });
    if (token !== nativeChatStreamToken) return;
    nativeChatHistory = Array.isArray(history?.messages) ? history.messages : [];
  } finally {
    nativeChatHistoryInFlight = false;
  }
}

function scheduleNativeChatHistoryRefresh(projectPath, sessionId, token, delayMs = 0) {
  if (nativeChatHistoryTimer) {
    clearTimeout(nativeChatHistoryTimer);
    nativeChatHistoryTimer = null;
  }
  nativeChatHistoryTimer = setTimeout(() => {
    if (token !== nativeChatStreamToken) return;
    void refreshNativeChatHistory(projectPath, sessionId, token);
  }, delayMs);
}

function scheduleNativeChatReconnect(projectPath, sessionId, endpoint, token, delayMs = 1000) {
  if (nativeChatReconnectTimer) {
    clearTimeout(nativeChatReconnectTimer);
    nativeChatReconnectTimer = null;
  }
  nativeChatReconnectTimer = setTimeout(() => {
    if (token !== nativeChatStreamToken) return;
    startNativeChatStream(projectPath, sessionId, endpoint, token);
  }, delayMs);
}

function buildNativeChatStreamUrl(endpoint, sessionId) {
  if (!endpoint?.host || !endpoint?.port) return null;
  const url = new URL(`http://${endpoint.host}:${endpoint.port}/events`);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("startLine", "-120");
  url.searchParams.set("intervalMs", "250");
  return url.toString();
}

async function fetchNativeChatSnapshot(projectPath, sessionId, token) {
  try {
    const [result, history] = await Promise.all([
      invoke("agent_read", {
        projectPath,
        sessionId,
        startLine: -120,
      }),
      invoke("agent_history", {
        projectPath,
        sessionId,
        lastN: 20,
      }),
    ]);
    if (token !== nativeChatStreamToken) return;
    setNativeChatSnapshot(projectPath, sessionId, { ...result, history });
    nativeChatLoading = false;
  } catch (error) {
    if (token !== nativeChatStreamToken) return;
    nativeChatError = String(error);
    nativeChatLoading = false;
  }
}

function startNativeChatStream(projectPath, sessionId, endpoint, token) {
  if (!endpoint?.host || !endpoint?.port || typeof EventSource === "undefined") {
    void fetchNativeChatSnapshot(projectPath, sessionId, token);
    return;
  }

  if (nativeChatStream) {
    nativeChatStream.close();
    nativeChatStream = null;
  }
  if (nativeChatReconnectTimer) {
    clearTimeout(nativeChatReconnectTimer);
    nativeChatReconnectTimer = null;
  }

  const streamUrl = buildNativeChatStreamUrl(endpoint, sessionId);
  if (!streamUrl) {
    void fetchNativeChatSnapshot(projectPath, sessionId, token);
    return;
  }
  const stream = new EventSource(streamUrl);
  nativeChatStream = stream;
  startNativeChatResync(projectPath, sessionId, token, 1000);

  stream.addEventListener("ready", () => {
    if (token !== nativeChatStreamToken) return;
    nativeChatError = null;
    scheduleNativeChatHistoryRefresh(projectPath, sessionId, token, 0);
    void fetchNativeChatSnapshot(projectPath, sessionId, token);
  });

  const handleOutput = (event) => {
    if (token !== nativeChatStreamToken) return;
    const payload = JSON.parse(event.data || "{}");
    setNativeChatSnapshot(projectPath, sessionId, {
      output: payload.output,
      parsed: payload.parsed,
      history: { messages: nativeChatHistory },
    });
    nativeChatLoading = false;
  };

  stream.addEventListener("agent_output", handleOutput);

  stream.addEventListener("history_update", (event) => {
    if (token !== nativeChatStreamToken) return;
    const payload = JSON.parse(event.data || "{}");
    setNativeChatSnapshot(projectPath, sessionId, {
      output: nativeChatOutput,
      parsed: { blocks: nativeChatBlocks },
      history: { messages: Array.isArray(payload.messages) ? payload.messages : [] },
    });
    nativeChatLoading = false;
  });

  stream.addEventListener("error", () => {
    if (token !== nativeChatStreamToken) return;
    if (nativeChatStream === stream) {
      nativeChatStream.close();
      nativeChatStream = null;
    }
    if (!nativeChatOutput) {
      void fetchNativeChatSnapshot(projectPath, sessionId, token);
    }
    scheduleNativeChatReconnect(projectPath, sessionId, endpoint, token, 1000);
  });
}

function syncNativeChatSelection({ preserveSnapshot = false } = {}) {
  if (interactionMode !== "native-chat") {
    stopNativeChatStreaming();
    return;
  }
  if (!selectedProjectPath || !selectedSessionId) {
    stopNativeChatStreaming({ clear: true });
    return;
  }

  if (nativeChatHistoryTimer) {
    clearTimeout(nativeChatHistoryTimer);
    nativeChatHistoryTimer = null;
  }
  nativeChatHistoryInFlight = false;
  beginNativeChatSelection(selectedProjectPath, selectedSessionId, { preserveSnapshot });
  nativeChatStreamToken += 1;
  const token = nativeChatStreamToken;
  const project = projects.find((p) => p.path === selectedProjectPath) || null;
  startNativeChatStream(
    selectedProjectPath,
    selectedSessionId,
    project?.serviceEndpoint || null,
    token,
  );
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
    get currentAlert() { return currentAlert; },
    get recentAlerts() { return recentAlerts; },
    get nativeChatOutput() { return nativeChatOutput; },
    get nativeChatBlocks() { return nativeChatBlocks; },
    get nativeChatHistory() { return nativeChatHistory; },
    get nativeChatLoading() { return nativeChatLoading; },
    get nativeChatError() { return nativeChatError; },
    get nativeChatComposerError() { return nativeChatComposerError; },
    get nativeChatProjectPath() { return nativeChatProjectPath; },
    get nativeChatSessionId() { return nativeChatSessionId; },
    get nativeChatRawMode() { return nativeChatRawMode; },
    set nativeChatRawMode(v) { nativeChatRawMode = v; },
    get nativeChatDraftParts() { return selectedSessionId ? getNativeChatDraftPartsForSession(selectedSessionId) : []; },
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
    get controlPlane() {
      const project = applyActionOverlays(projects.find((p) => p.path === selectedProjectPath) || null);
      return buildControlPlaneSnapshot(project);
    },
  };
}

// ── Heartbeat listener (Rust pushes events, JS just receives) ─────

function onHeartbeat(event) {
  const incoming = event.payload?.projects || [];
  expectedServiceInfo = event.payload?.expectedServiceInfo || null;
  incoming.sort((a, b) => a.name.localeCompare(b.name));
  lastHeartbeatAt = Date.now();
  reconcileActions(incoming);
  projects = incoming;
  syncProjectAlertStreams(projects);

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
      stopNativeChatStreaming({ clear: true });
      return;
    }

    if (interactionMode === "native-chat") {
      const endpoint = selectedProject?.serviceEndpoint || null;
      const desiredUrl = buildNativeChatStreamUrl(endpoint, selectedSessionId);
      if (!desiredUrl && nativeChatStream) {
        syncNativeChatSelection({ preserveSnapshot: true });
      } else if (desiredUrl && nativeChatStream?.url !== desiredUrl) {
        syncNativeChatSelection({ preserveSnapshot: true });
      }
    }
  }

  const selectedProject = incoming.find((project) => project.path === selectedProjectPath);
  const selectedServiceInfo = getProjectServiceInfo(selectedProject);
  const selectedMissingCapabilities = getMissingProjectServiceCapabilities(selectedProject);
  const selectedBuildMismatch =
    Boolean(selectedProject?.serviceEndpointAlive) &&
    Boolean(expectedServiceInfo?.buildStamp) &&
    Boolean(selectedServiceInfo?.buildStamp) &&
    !manifestsMatch(expectedServiceInfo, selectedServiceInfo);
  const selectedOutdated =
    Boolean(selectedProject?.serviceEndpointAlive) &&
    (
      !selectedServiceInfo ||
      Number(selectedServiceInfo.apiVersion || 0) < REQUIRED_PROJECT_SERVICE_API_VERSION ||
      selectedMissingCapabilities.length > 0 ||
      selectedBuildMismatch
    );
  if (!selectedOutdated && selectedProject?.serviceEndpointAlive !== false && selectedProject?.serviceAlive !== false) {
    controlPlaneError = null;
  }
}

export async function startHeartbeat() {
  stopHeartbeat();
  lastHeartbeatAt = Date.now();
  heartbeatTicker = Date.now();
  heartbeatInterval = setInterval(() => {
    heartbeatTicker = Date.now();
  }, 1000);
  unlistenHeartbeat = await listen("heartbeat", onHeartbeat);
}

export function stopHeartbeat() {
  if (unlistenHeartbeat) {
    unlistenHeartbeat();
    unlistenHeartbeat = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  for (const [projectPath] of projectAlertStreams) {
    stopProjectAlertStream(projectPath);
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
  stopNativeChatStreaming({ clear: true });
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

function createNativeChatTextPart(text = "") {
  return {
    id: crypto.randomUUID(),
    type: "text",
    text,
  };
}

function createNativeChatImagePart(image) {
  return {
    id: crypto.randomUUID(),
    type: "image",
    attachmentId: image.attachmentId,
    name: image.name || image.filename || "image",
    path: image.path || null,
    contentUrl: image.contentUrl || null,
    mimeType: image.mimeType || null,
    previewUrl: image.previewUrl || null,
  };
}

function getNativeChatDraftPartsForSession(sessionId) {
  const existing = nativeChatDraftParts[sessionId];
  return existing && existing.length > 0 ? existing : [createNativeChatTextPart("")];
}

function normalizeNativeChatDraftParts(parts) {
  const next = [];

  for (const part of parts || []) {
    if (!part) continue;
    if (part.type === "image") {
      if (!part.attachmentId) continue;
      next.push({ ...part });
      continue;
    }

    const text = String(part.text || "");
    if (next.length > 0 && next[next.length - 1].type === "text") {
      next[next.length - 1] = {
        ...next[next.length - 1],
        text: `${next[next.length - 1].text || ""}${text}`,
      };
    } else {
      next.push({
        id: part.id || crypto.randomUUID(),
        type: "text",
        text,
      });
    }
  }

  const withTextBoundaries = [];
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    const previousPart = withTextBoundaries[withTextBoundaries.length - 1];
    if (part.type === "image" && previousPart?.type !== "text") {
      withTextBoundaries.push(createNativeChatTextPart(""));
    }
    withTextBoundaries.push(part);
    const followingPart = next[index + 1];
    if (part.type === "image" && followingPart?.type !== "text") {
      withTextBoundaries.push(createNativeChatTextPart(""));
    }
  }

  if (withTextBoundaries.length === 0 || withTextBoundaries[0]?.type !== "text") {
    withTextBoundaries.unshift(createNativeChatTextPart(""));
  }
  if (withTextBoundaries[withTextBoundaries.length - 1]?.type !== "text") {
    withTextBoundaries.push(createNativeChatTextPart(""));
  }

  const deduped = [];
  for (const part of withTextBoundaries) {
    if (part.type === "text" && deduped[deduped.length - 1]?.type === "text") {
      deduped[deduped.length - 1] = {
        ...deduped[deduped.length - 1],
        text: `${deduped[deduped.length - 1].text || ""}${part.text || ""}`,
      };
      continue;
    }
    deduped.push(part);
  }

  if (deduped.length === 0) {
    return [createNativeChatTextPart("")];
  }
  return deduped;
}

function setNativeChatDraftPartsForSession(sessionId, parts) {
  nativeChatDraftParts = {
    ...nativeChatDraftParts,
    [sessionId]: normalizeNativeChatDraftParts(parts),
  };
}

function insertNativeChatImageParts(sessionId, images, afterTextPartId) {
  const current = getNativeChatDraftPartsForSession(sessionId);
  const index = current.findIndex((part) => part.id === afterTextPartId && part.type === "text");
  const anchorIndex = index >= 0 ? index : Math.max(0, current.length - 1);
  const imageParts = images.flatMap((image) => [createNativeChatImagePart(image), createNativeChatTextPart("")]);
  const next = [...current.slice(0, anchorIndex + 1), ...imageParts, ...current.slice(anchorIndex + 1)];
  setNativeChatDraftPartsForSession(sessionId, next);
}

export function setNativeChatDraftTextPart(partId, value) {
  if (!selectedSessionId) return;
  const next = getNativeChatDraftPartsForSession(selectedSessionId).map((part) =>
    part.id === partId && part.type === "text" ? { ...part, text: value } : part
  );
  setNativeChatDraftPartsForSession(selectedSessionId, next);
}

export async function addNativeChatImages(imageInputs, afterTextPartId) {
  if (!selectedSessionId || !selectedProjectPath || !Array.isArray(imageInputs) || imageInputs.length === 0) return;
  nativeChatComposerError = null;
  const sessionId = selectedSessionId;
  const projectPath = selectedProjectPath;
  const ingested = await trackAction(
    {
      kind: "agent-attach",
      message: `Adding image${imageInputs.length > 1 ? "s" : ""}...`,
      projectPath,
      sessionId,
    },
    () =>
      Promise.all(
        imageInputs.map(async (image) => {
          let result;
          if (image.path) {
            result = await invoke("attachment_ingest_path", {
              projectPath,
              path: image.path,
            });
          } else {
            result = await invoke("attachment_ingest_base64", {
              projectPath,
              filename: image.name || image.filename || "image",
              mimeType: image.mimeType || "application/octet-stream",
              contentBase64: image.contentBase64,
            });
          }
          return {
            ...image,
            attachmentId: result?.attachment?.id || null,
            contentUrl: result?.attachment?.contentUrl || null,
          };
        }),
      ),
  );
  insertNativeChatImageParts(sessionId, ingested.filter((image) => image.attachmentId), afterTextPartId);
}

export async function pickNativeChatImages(afterTextPartId) {
  if (!selectedSessionId || !selectedProjectPath) return;
  nativeChatComposerError = null;
  const picked = await invoke("pick_images");
  if (!Array.isArray(picked) || picked.length === 0) return;
  try {
    await addNativeChatImages(picked, afterTextPartId);
  } catch (error) {
    nativeChatComposerError = String(error);
    throw error;
  }
}

export function removeNativeChatDraftPart(partId) {
  if (!selectedSessionId) return;
  const next = getNativeChatDraftPartsForSession(selectedSessionId).filter((part) => part.id !== partId);
  setNativeChatDraftPartsForSession(selectedSessionId, next);
}

export async function sendNativeChatMessage() {
  const projectPath = selectedProjectPath;
  const sessionId = selectedSessionId;
  nativeChatComposerError = null;
  const draftParts = sessionId ? getNativeChatDraftPartsForSession(sessionId) : [];
  const outboundParts = draftParts.filter((part) =>
    part.type === "image" ? Boolean(part.attachmentId) : String(part.text || "").trim().length > 0
  );
  if (!projectPath || !sessionId || outboundParts.length === 0) return;

  const parts = [];
  const historyParts = [];
  for (const part of outboundParts) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      historyParts.push({ type: "text", text: part.text });
    } else {
      parts.push({
        type: "image",
        attachmentId: part.attachmentId,
        alt: part.name,
      });
      historyParts.push({
        type: "image",
        attachmentId: part.attachmentId,
        filename: part.name || "image",
        mimeType: part.mimeType || undefined,
        contentUrl: part.contentUrl || undefined,
      });
    }
  }

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
        data: "",
        parts,
        submit: true,
      }),
  );

  nativeChatHistory = [
    ...nativeChatHistory,
    {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      ts: new Date().toISOString(),
      parts: historyParts,
    },
  ];
  setNativeChatDraftPartsForSession(sessionId, [createNativeChatTextPart("")]);
}

export async function restartControlPlane() {
  const projectPath = selectedProjectPath;
  if (!projectPath) return;
  await trackAction(
    {
      kind: "restart-control-plane",
      message: "Restarting control plane...",
      projectPath,
    },
    () => invoke("restart_control_plane", { projectPath }),
  );
}

export async function restartProjectService(opts = {}) {
  const projectPath = selectedProjectPath;
  if (!projectPath) return;
  controlPlaneError = null;
  try {
    await trackAction(
      {
        kind: "restart-project-service",
        message: opts.auto ? "Repairing stale project service..." : "Restarting project service...",
        projectPath,
      },
      () => invoke("restart_project_service", { projectPath }),
    );
  } catch (error) {
    controlPlaneError = String(error);
    throw error;
  }
}

export async function restartDaemonControl() {
  controlPlaneError = null;
  try {
    await trackAction(
      {
        kind: "restart-daemon",
        message: "Restarting daemon and recovering projects...",
      },
      () => invoke("restart_daemon"),
    );
  } catch (error) {
    controlPlaneError = String(error);
    throw error;
  }
}
