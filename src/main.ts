import { Command } from "commander";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  mkdirSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join as pathJoin, resolve as pathResolve, dirname as pathDirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Multiplexer } from "./multiplexer.js";
import { llmCompact } from "./context/compactor.js";
import { initProject } from "./config.js";
import { initPaths, getHistoryDir, getGraveyardPath, getStatePath, getContextDir } from "./paths.js";
import { loadTeamConfig, saveTeamConfig, getDefaultTeamConfig } from "./team.js";
import { createWorktree, findMainRepo, listWorktrees } from "./worktree.js";
import { isDashboardWindowName, TmuxRuntimeManager } from "./tmux-runtime-manager.js";
import { buildTmuxDoctorReport, renderTmuxDoctorReport } from "./tmux-doctor.js";
import { renderTmuxStatusline, type TmuxStatusLine } from "./tmux-statusline.js";
import {
  loadMetadataEndpoint,
  loadMetadataState,
  updateSessionMetadata,
  clearSessionLogs,
  type MetadataTone,
  type SessionContextMetadata,
  type SessionServiceMetadata,
  removeMetadataEndpoint,
} from "./metadata-store.js";
import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState, AgentAttentionState, AgentEventKind } from "./agent-events.js";
import { listDesktopProjects, scanProject } from "./project-scanner.js";
import {
  AimuxDaemon,
  ensureDaemonRunning,
  ensureProjectService,
  loadDaemonInfo,
  loadDaemonState,
  projectServiceStatus,
  requestDaemonJson,
  stopDaemon,
  stopProjectService,
} from "./daemon.js";
import {
  appendMessage,
  createThread,
  listThreadSummaries,
  markThreadSeen,
  readMessages,
  readThread,
  setThreadStatus,
  type MessageKind,
  type ThreadKind,
  type ThreadStatus,
} from "./threads.js";
import { sendDirectMessage, sendThreadMessage } from "./orchestration.js";
import { acceptHandoff, assignTask, completeHandoff, sendHandoff } from "./orchestration-actions.js";

const program = new Command();

async function postProjectServiceJson(path: string, body: unknown): Promise<any> {
  let endpoint = loadMetadataEndpoint();
  if (!endpoint) {
    await ensureProjectService(resolveProjectRoot(process.cwd()));
    endpoint = loadMetadataEndpoint();
  }
  if (!endpoint) {
    throw new Error("no live project service metadata endpoint");
  }
  const res = await fetch(`http://${endpoint.host}:${endpoint.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || `request failed: ${res.status}`);
  }
  return json;
}

async function ensureDaemonProjectReady(projectRoot: string): Promise<void> {
  await ensureDaemonRunning();
  await ensureProjectService(projectRoot);
}

function resolveProjectRoot(cwd: string): string {
  try {
    return findMainRepo(cwd);
  } catch {
    return cwd;
  }
}

function ensureTmuxAvailable(tmux: TmuxRuntimeManager): void {
  if (!tmux.isAvailable()) {
    console.error("aimux: tmux is not installed or not available in PATH");
    process.exit(1);
  }
}

function getDashboardCommandSpec(projectRoot: string) {
  const scriptPath = fileURLToPath(import.meta.url);
  return {
    scriptPath,
    dashboardBuildStamp: String(statSync(scriptPath).mtimeMs),
    dashboardCommand: {
      cwd: projectRoot,
      command: process.execPath,
      args: [scriptPath, "--tmux-dashboard-internal"],
    },
    statuslineCommand: {
      command: process.execPath,
      args: [scriptPath, "tmux-statusline"],
    },
  };
}

function ensureDashboardTarget(projectRoot: string, tmux = new TmuxRuntimeManager()) {
  const { dashboardBuildStamp, dashboardCommand, statuslineCommand } = getDashboardCommandSpec(projectRoot);
  const dashboardSession = tmux.ensureProjectSession(
    projectRoot,
    {
      cwd: dashboardCommand.cwd,
      command: dashboardCommand.command,
      args: dashboardCommand.args,
    },
    statuslineCommand,
  );
  const openSessionName = tmux.getOpenSessionName(dashboardSession.sessionName, tmux.isInsideTmux());
  const dashboardTarget = tmux.ensureDashboardWindow(openSessionName, projectRoot, dashboardCommand);
  const currentBuildStamp = tmux.getWindowOption(dashboardTarget, "@aimux-dashboard-build");
  const shouldRespawnDashboard = !tmux.isWindowAlive(dashboardTarget) || currentBuildStamp !== dashboardBuildStamp;
  if (shouldRespawnDashboard) {
    tmux.respawnWindow(dashboardTarget, dashboardCommand);
    tmux.setWindowOption(dashboardTarget, "@aimux-dashboard-build", dashboardBuildStamp);
  }
  return { dashboardSession, dashboardTarget };
}

function forceReloadDashboardTarget(projectRoot: string, tmux = new TmuxRuntimeManager()) {
  const { dashboardBuildStamp, dashboardCommand, statuslineCommand } = getDashboardCommandSpec(projectRoot);
  const dashboardSession = tmux.ensureProjectSession(
    projectRoot,
    {
      cwd: dashboardCommand.cwd,
      command: dashboardCommand.command,
      args: dashboardCommand.args,
    },
    statuslineCommand,
  );
  const openSessionName = tmux.getOpenSessionName(dashboardSession.sessionName, tmux.isInsideTmux());
  const dashboardTarget = tmux.ensureDashboardWindow(openSessionName, projectRoot, dashboardCommand);
  tmux.respawnWindow(dashboardTarget, dashboardCommand);
  tmux.setWindowOption(dashboardTarget, "@aimux-dashboard-build", dashboardBuildStamp);
  return { dashboardSession, dashboardTarget };
}

program
  .name("aimux")
  .description("Native CLI agent multiplexer")
  .version("0.1.0")
  .argument("[tool]", "Tool to run (e.g. claude, codex, aider)")
  .argument("[args...]", "Arguments to pass to the tool")
  .option("--resume", "Resume previous sessions using native tool resume")
  .option("--restore", "Start fresh sessions with injected history context")
  .option("--tmux-dashboard-internal", "Internal tmux dashboard entrypoint")
  .hook("preAction", async (_thisCommand, actionCommand) => {
    const opts = typeof actionCommand?.opts === "function" ? actionCommand.opts() : {};
    const requestedProject = typeof opts.project === "string" ? opts.project : undefined;
    const projectRoot = requestedProject ? resolveProjectRoot(pathResolve(requestedProject)) : undefined;
    await initPaths(projectRoot);
  })
  .action(
    async (
      tool: string | undefined,
      args: string[],
      opts: { resume?: boolean; restore?: boolean; tmuxDashboardInternal?: boolean },
    ) => {
      const originalCwd = process.cwd();
      const dashboardMode = !tool && !opts.resume && !opts.restore;
      const shouldAnchorToMainRepo = opts.tmuxDashboardInternal || dashboardMode;
      let projectRoot = originalCwd;
      if (shouldAnchorToMainRepo) {
        try {
          projectRoot = findMainRepo(originalCwd);
        } catch {
          projectRoot = originalCwd;
        }
        if (projectRoot !== originalCwd) {
          process.chdir(projectRoot);
        }
      }
      if (!opts.tmuxDashboardInternal) {
        initProject();
        await ensureDaemonProjectReady(projectRoot);
        const tmux = new TmuxRuntimeManager();
        ensureTmuxAvailable(tmux);
        const { dashboardTarget } = ensureDashboardTarget(projectRoot, tmux);
        if (!tool && !opts.resume && !opts.restore) {
          tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux() });
          return;
        }
      }

      const mux = new Multiplexer();
      let cleanedUp = false;
      const ensureTerminalRestored = () => mux.cleanupTerminalOnly();
      const cleanupAll = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        mux.cleanup();
      };

      // Graceful shutdown on signals
      const shutdown = () => {
        cleanupAll();
        process.exit(0);
      };
      process.on("exit", ensureTerminalRestored);
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("uncaughtException", (err) => {
        cleanupAll();
        console.error(err);
        process.exit(1);
      });
      process.on("unhandledRejection", (reason) => {
        cleanupAll();
        console.error(reason);
        process.exit(1);
      });

      try {
        let exitCode: number;
        if (opts.resume) {
          exitCode = await mux.resumeSessions(tool);
        } else if (opts.restore) {
          exitCode = await mux.restoreSessions(tool);
        } else if (tool) {
          exitCode = await mux.run({ command: tool, args });
        } else {
          exitCode = await mux.runDashboard();
        }
        cleanupAll();
        process.exit(exitCode);
      } catch (err: unknown) {
        cleanupAll();
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`aimux: failed to spawn "${tool}": ${msg}`);
        process.exit(1);
      }
    },
  );

program
  .command("init")
  .description("Initialize .aimux directory with default config and gitignore")
  .action(() => {
    initProject();
    console.log("Initialized .aimux/ with config.json and .gitignore");
  });

program
  .command("dashboard-reload")
  .description("Force reload the managed tmux dashboard for this project")
  .option("--open", "Open the dashboard after reloading")
  .action((opts: { open?: boolean }) => {
    const originalCwd = process.cwd();
    const projectRoot = resolveProjectRoot(originalCwd);

    const tmux = new TmuxRuntimeManager();
    ensureTmuxAvailable(tmux);
    const { dashboardSession, dashboardTarget } = forceReloadDashboardTarget(projectRoot, tmux);

    if (opts.open) {
      tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux() });
      return;
    }

    console.log(`Reloaded dashboard for ${dashboardSession.sessionName}`);
  });

const hostCmd = program.command("host").description("Compatibility wrappers for daemon-managed project services");

program
  .command("serve")
  .description("Ensure the daemon-backed project control service is running")
  .action(async () => {
    const projectRoot = resolveProjectRoot(process.cwd());
    if (projectRoot !== process.cwd()) {
      process.chdir(projectRoot);
    }
    await initPaths(projectRoot);
    await ensureDaemonProjectReady(projectRoot);
    const status = await projectServiceStatus(projectRoot);
    console.log(`aimux serve: daemon managing ${projectRoot}${status ? ` (service pid ${status.pid})` : ""}`);
  });

hostCmd
  .command("status")
  .description("Show current project control-service status")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    await initPaths();
    await ensureDaemonRunning();
    const projectRoot = resolveProjectRoot(process.cwd());
    const project = await projectServiceStatus(projectRoot);
    const endpoint = loadMetadataEndpoint(projectRoot);
    const tmux = new TmuxRuntimeManager();
    const session = tmux.getProjectSession(projectRoot);
    const payload = {
      projectRoot,
      sessionName: session.sessionName,
      daemon: loadDaemonInfo(),
      projectService: project,
      metadataEndpoint: endpoint,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!project) {
      console.log(`No live control service for ${session.sessionName}`);
      return;
    }
    console.log(`Service pid=${project.pid}`);
    console.log(`Started: ${project.startedAt}`);
    console.log(`Metadata: ${endpoint ? `http://${endpoint.host}:${endpoint.port}` : "not running"}`);
    console.log(`Tmux session: ${session.sessionName}`);
  });

hostCmd
  .command("stop")
  .description("Stop the current project's daemon-managed control service")
  .action(async () => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    const result = await stopProjectService(projectRoot);
    if (!result) {
      console.log("No live project service to stop.");
      return;
    }
    removeMetadataEndpoint();
    console.log(`Stopped project service pid ${result.pid}`);
  });

hostCmd
  .command("kill")
  .description("Force kill the current project's daemon-managed control service")
  .action(async () => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    const result = await stopProjectService(projectRoot);
    if (!result) {
      console.log("No live project service to kill.");
      return;
    }
    removeMetadataEndpoint();
    console.log(`Killed project service pid ${result.pid}`);
  });

hostCmd
  .command("restart")
  .description("Restart the current project's daemon-managed control service")
  .option("--open", "Open the dashboard after restarting")
  .option("--serve", "Restart the project service without reopening the dashboard")
  .action(async (opts: { open?: boolean; serve?: boolean }) => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    await stopProjectService(projectRoot);
    removeMetadataEndpoint();
    await ensureDaemonProjectReady(projectRoot);
    if (opts.serve) return;
    const tmux = new TmuxRuntimeManager();
    ensureTmuxAvailable(tmux);
    const { dashboardSession, dashboardTarget } = forceReloadDashboardTarget(projectRoot, tmux);
    if (opts.open) {
      tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux() });
      return;
    }
    console.log(`Restarted project service for ${dashboardSession.sessionName}`);
  });

hostCmd.action(() => {
  console.log("`aimux host` is a compatibility alias for daemon-managed project services.");
});

const daemonCmd = program.command("daemon").description("Manage the global aimux control-plane daemon");

daemonCmd
  .command("run")
  .description("Internal daemon entrypoint")
  .action(async () => {
    const daemon = new AimuxDaemon();
    await daemon.start();
    const shutdown = () => {
      daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  });

daemonCmd
  .command("ensure")
  .description("Ensure the global aimux daemon is running")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const info = await ensureDaemonRunning();
    if (opts.json) {
      console.log(JSON.stringify({ daemon: info }, null, 2));
      return;
    }
    console.log(`aimux daemon: pid ${info.pid} on http://127.0.0.1:${info.port}`);
  });

daemonCmd
  .command("stop")
  .description("Stop the global aimux daemon")
  .action(async () => {
    const info = await stopDaemon("SIGTERM");
    if (!info) {
      console.log("aimux daemon is not running.");
      return;
    }
    console.log(`Stopped daemon pid ${info.pid}`);
  });

daemonCmd
  .command("kill")
  .description("Force kill the global aimux daemon")
  .action(async () => {
    const info = await stopDaemon("SIGKILL");
    if (!info) {
      console.log("aimux daemon is not running.");
      return;
    }
    console.log(`Killed daemon pid ${info.pid}`);
  });

daemonCmd
  .command("restart")
  .description("Restart the global aimux daemon")
  .action(async () => {
    await stopDaemon("SIGTERM");
    const info = await ensureDaemonRunning();
    console.log(`Restarted daemon pid ${info.pid} on http://127.0.0.1:${info.port}`);
  });

daemonCmd
  .command("status")
  .description("Show daemon status")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const info = loadDaemonInfo();
    const state = loadDaemonState();
    const payload = {
      daemon: info,
      projects: Object.values(state.projects),
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!info) {
      console.log("aimux daemon is not running.");
      return;
    }
    console.log(`Daemon pid=${info.pid} port=${info.port}`);
    console.log(`Managed projects: ${Object.keys(state.projects).length}`);
  });

daemonCmd
  .command("projects")
  .description("List projects through the daemon")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    await ensureDaemonRunning();
    const result = await requestDaemonJson("/projects");
    if (opts.json) {
      console.log(JSON.stringify({ projects: result.projects }, null, 2));
      return;
    }
    for (const project of result.projects as Array<any>) {
      const badge = project.serviceAlive ? "service" : "idle";
      console.log(`${project.name}  ${badge}  ${project.path}`);
    }
  });

daemonCmd
  .command("project-ensure")
  .description("Ensure a project's control service is running")
  .requiredOption("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project: string; json?: boolean }) => {
    const projectRoot = resolveProjectRoot(pathResolve(opts.project));
    const project = await ensureProjectService(projectRoot);
    if (opts.json) {
      console.log(JSON.stringify({ project }, null, 2));
      return;
    }
    console.log(`Ensured project service for ${projectRoot} (pid ${project.pid})`);
  });

program
  .command("__project-service-internal")
  .description("Internal daemon-managed project service entrypoint")
  .action(async () => {
    const projectRoot = resolveProjectRoot(process.cwd());
    if (projectRoot !== process.cwd()) {
      process.chdir(projectRoot);
    }
    await initPaths(projectRoot);
    initProject();

    const mux = new Multiplexer();
    let cleanedUp = false;
    const ensureTerminalRestored = () => mux.cleanupTerminalOnly();
    const cleanupAll = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      mux.cleanup();
    };

    const shutdown = () => {
      cleanupAll();
      process.exit(0);
    };
    process.on("exit", ensureTerminalRestored);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("uncaughtException", (err) => {
      cleanupAll();
      console.error(err);
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      cleanupAll();
      console.error(reason);
      process.exit(1);
    });

    try {
      const exitCode = await mux.runProjectService();
      cleanupAll();
      process.exit(exitCode);
    } catch (err: unknown) {
      cleanupAll();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`aimux project service: ${msg}`);
      process.exit(1);
    }
  });

const projectsCmd = program.command("projects").description("Inspect known aimux projects");

projectsCmd
  .command("list")
  .description("List known aimux projects")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    await ensureDaemonRunning();
    const result = await requestDaemonJson("/projects");
    const projects = result.projects as ReturnType<typeof listDesktopProjects>;
    if (opts.json) {
      console.log(JSON.stringify({ projects }, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log("No aimux projects found.");
      return;
    }

    for (const project of projects) {
      const liveBadge = project.sessions.some((session) => session.status !== "offline") ? "live" : "idle";
      console.log(`${project.name}  ${liveBadge}  ${project.path}`);
      if (project.sessions.length === 0) continue;
      for (const session of project.sessions) {
        const label = session.label ? ` ${session.label}` : "";
        const headline = session.headline ? ` - ${session.headline}` : "";
        console.log(`  ${session.id}  ${session.tool}  ${session.status}${label}${headline}`);
      }
    }
  });

const desktopCmd = program.command("desktop").description("Desktop shell integration commands");

desktopCmd
  .command("open")
  .description("Open or attach to a project's dashboard")
  .requiredOption("--project <path>", "Project path")
  .action(async (opts: { project: string }) => {
    const requestedPath = pathResolve(opts.project);
    const projectRoot = resolveProjectRoot(requestedPath);
    await initPaths(projectRoot);
    initProject();
    await ensureDaemonProjectReady(projectRoot);

    const tmux = new TmuxRuntimeManager();
    ensureTmuxAvailable(tmux);
    const { dashboardTarget } = ensureDashboardTarget(projectRoot, tmux);
    tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux() });
  });

desktopCmd
  .command("focus")
  .description("Focus a running aimux session in its tmux window")
  .requiredOption("--project <path>", "Project path")
  .requiredOption("--session <id>", "Aimux session id")
  .action(async (opts: { project: string; session: string }) => {
    const requestedPath = pathResolve(opts.project);
    const projectRoot = resolveProjectRoot(requestedPath);
    await initPaths(projectRoot);
    await ensureDaemonProjectReady(projectRoot);

    const tmux = new TmuxRuntimeManager();
    ensureTmuxAvailable(tmux);
    const tmuxSession = tmux.getProjectSession(projectRoot);
    const match = tmux.findManagedWindow(tmuxSession.sessionName, { sessionId: opts.session });
    if (!match) {
      const scanned = scanProject(projectRoot);
      const knownSession = scanned.sessions.find((session) => session.id === opts.session);
      if (knownSession?.status === "offline") {
        console.error(`aimux: session "${opts.session}" is offline in ${projectRoot}`);
      } else if (knownSession) {
        console.error(`aimux: session "${opts.session}" exists but has no live tmux window`);
      } else {
        console.error(`aimux: session "${opts.session}" not found in ${projectRoot}`);
      }
      process.exit(1);
    }

    tmux.openTarget(match.target, { insideTmux: tmux.isInsideTmux() });
  });

desktopCmd
  .command("dashboard-target")
  .description("Show the resolved dashboard tmux target for a project")
  .requiredOption("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project: string; json?: boolean }) => {
    const requestedPath = pathResolve(opts.project);
    const projectRoot = resolveProjectRoot(requestedPath);
    await initPaths(projectRoot);
    await ensureDaemonProjectReady(projectRoot);

    const tmux = new TmuxRuntimeManager();
    ensureTmuxAvailable(tmux);
    const { dashboardSession, dashboardTarget } = ensureDashboardTarget(projectRoot, tmux);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            projectRoot,
            sessionName: dashboardSession.sessionName,
            target: dashboardTarget,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`${dashboardSession.sessionName}:${dashboardTarget.windowIndex}`);
  });

program
  .command("compact")
  .description("Compact session history using LLM summarization")
  .action(() => {
    const historyDir = getHistoryDir();
    let sessionIds: string[] = [];
    try {
      sessionIds = readdirSync(historyDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, ""));
    } catch {
      console.error("No history found at " + historyDir);
      process.exit(1);
    }

    if (sessionIds.length === 0) {
      console.error("No session history files found.");
      process.exit(1);
    }

    console.log(`Compacting history for ${sessionIds.length} session(s)...`);
    llmCompact(sessionIds);
    console.log(`Done. Summary written to ${getContextDir()}/summary.md`);
  });

async function prepareProjectContext(requestedProject?: string): Promise<string> {
  const requestedPath = pathResolve(requestedProject ?? process.cwd());
  const projectRoot = resolveProjectRoot(requestedPath);
  await initPaths(projectRoot);
  process.chdir(projectRoot);
  return projectRoot;
}

function printWorktrees(projectRoot?: string): void {
  try {
    const worktrees = listWorktrees(projectRoot);
    if (worktrees.length === 0) {
      console.log("No worktrees found.");
      return;
    }
    console.log("Name".padEnd(30) + "Branch".padEnd(35) + "Path");
    console.log("-".repeat(95));
    for (const wt of worktrees) {
      console.log(wt.name.padEnd(30) + wt.branch.padEnd(35) + wt.path);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

const worktreeCmd = program.command("worktree").description("Manage git worktrees");

worktreeCmd.action(() => {
  printWorktrees();
});

const threadCmd = program.command("thread").description("Inspect and manage orchestration threads");

threadCmd
  .command("list")
  .description("List orchestration threads")
  .option("--session <sessionId>", "Filter to threads involving a session")
  .option("--json", "Emit JSON")
  .action((opts: { session?: string; json?: boolean }) => {
    const summaries = listThreadSummaries(opts.session);
    if (opts.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }
    if (summaries.length === 0) {
      console.log("No threads found.");
      return;
    }
    for (const summary of summaries) {
      const unread = summary.thread.unreadBy?.length ? ` unread=${summary.thread.unreadBy.length}` : "";
      const waiting = summary.thread.waitingOn?.length ? ` waiting=${summary.thread.waitingOn.join(",")}` : "";
      console.log(`${summary.thread.id}  ${summary.thread.kind}  ${summary.thread.status}${unread}${waiting}`);
      console.log(`  ${summary.thread.title}`);
      if (summary.latestMessage) {
        console.log(
          `  latest: ${summary.latestMessage.from} [${summary.latestMessage.kind}] ${summary.latestMessage.body}`,
        );
      }
    }
  });

threadCmd
  .command("show")
  .description("Show a thread and its messages")
  .argument("<threadId>")
  .option("--json", "Emit JSON")
  .action((threadId: string, opts: { json?: boolean }) => {
    const thread = readThread(threadId);
    if (!thread) {
      console.error(`aimux: thread not found: ${threadId}`);
      process.exit(1);
    }
    const messages = readMessages(threadId);
    if (opts.json) {
      console.log(JSON.stringify({ thread, messages }, null, 2));
      return;
    }
    console.log(`${thread.title} (${thread.kind})`);
    console.log(`id: ${thread.id}`);
    console.log(`status: ${thread.status}`);
    console.log(`participants: ${thread.participants.join(", ")}`);
    if (thread.owner) console.log(`owner: ${thread.owner}`);
    if (thread.waitingOn?.length) console.log(`waitingOn: ${thread.waitingOn.join(", ")}`);
    console.log("");
    for (const message of messages) {
      console.log(`${message.ts}  ${message.from} [${message.kind}]`);
      console.log(`  ${message.body}`);
    }
  });

threadCmd
  .command("open")
  .description("Open a new orchestration thread")
  .requiredOption("--title <title>", "Thread title")
  .requiredOption("--from <sessionId>", "Creating session")
  .requiredOption("--participants <ids>", "Comma-separated participant session ids")
  .option("--kind <kind>", "conversation|task|review|handoff|user", "conversation")
  .action((opts: { title: string; from: string; participants: string; kind?: ThreadKind }) => {
    const participants = opts.participants
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const thread = createThread({
      title: opts.title,
      kind: (opts.kind as ThreadKind) ?? "conversation",
      createdBy: opts.from,
      participants: [...new Set([opts.from, ...participants])],
    });
    console.log(thread.id);
  });

threadCmd
  .command("send")
  .description("Append a message to an orchestration thread")
  .argument("<threadId>")
  .argument("<body>")
  .requiredOption("--from <sessionId>", "Sending session")
  .option("--to <ids>", "Comma-separated recipient session ids")
  .option("--kind <kind>", "request|reply|status|decision|handoff|note", "note")
  .action((threadId: string, body: string, opts: { from: string; to?: string; kind?: MessageKind }) => {
    const thread = readThread(threadId);
    if (!thread) {
      console.error(`aimux: thread not found: ${threadId}`);
      process.exit(1);
    }
    const to = opts.to
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const message = sendThreadMessage({
      threadId,
      from: opts.from,
      to,
      kind: (opts.kind as MessageKind) ?? "note",
      body,
    }).message;
    console.log(message.id);
  });

threadCmd
  .command("mark-seen")
  .description("Mark a thread as seen for a participant")
  .argument("<threadId>")
  .requiredOption("--session <sessionId>", "Participant session id")
  .action((threadId: string, opts: { session: string }) => {
    const thread = markThreadSeen(threadId, opts.session);
    if (!thread) {
      console.error(`aimux: thread not found: ${threadId}`);
      process.exit(1);
    }
    console.log("ok");
  });

threadCmd
  .command("status")
  .description("Update a thread status")
  .argument("<threadId>")
  .requiredOption("--status <status>", "open|waiting|blocked|done|abandoned")
  .option("--owner <sessionId>", "Override thread owner")
  .option("--waiting-on <ids>", "Comma-separated waitingOn participants")
  .action(async (threadId: string, opts: { status: ThreadStatus; owner?: string; waitingOn?: string }) => {
    const waitingOn = opts.waitingOn
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      const result = await postProjectServiceJson("/threads/status", {
        threadId,
        status: opts.status,
        owner: opts.owner,
        waitingOn,
      });
      console.log(`thread ${result.thread.id}`);
      console.log(`status ${result.thread.status}`);
      return;
    } catch {
      const thread = setThreadStatus(threadId, opts.status, {
        owner: opts.owner?.trim(),
        waitingOn,
      });
      if (!thread) {
        console.error(`aimux: thread not found: ${threadId}`);
        process.exit(1);
      }
      console.log(`thread ${thread.id}`);
      console.log(`status ${thread.status}`);
    }
  });

const messageCmd = program.command("message").description("Send directed orchestration messages");

messageCmd
  .command("send")
  .description("Send a direct message and open or reuse a conversation thread")
  .argument("<body>")
  .option("--to <ids>", "Comma-separated recipient session ids")
  .option("--assignee <role>", "Route to a role if no explicit session id is provided")
  .option("--tool <tool>", "Route to a tool if no explicit session id is provided")
  .option("--worktree <path>", "Prefer a target in this worktree")
  .option("--from <sessionId>", "Sender session id", "user")
  .option("--title <title>", "Conversation title if a new thread is opened")
  .option("--kind <kind>", "request|reply|status|decision|handoff|note", "request")
  .option("--thread <threadId>", "Append to an existing thread instead of opening/reusing a conversation")
  .action(
    async (
      body: string,
      opts: {
        to?: string;
        assignee?: string;
        tool?: string;
        worktree?: string;
        from?: string;
        title?: string;
        kind?: MessageKind;
        thread?: string;
      },
    ) => {
      const to = opts.to
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if ((!to || to.length === 0) && !opts.thread && !opts.assignee && !opts.tool) {
        console.error("aimux: message send requires --to, --assignee, or --tool");
        process.exit(1);
      }
      try {
        const result = await postProjectServiceJson("/threads/send", {
          threadId: opts.thread,
          from: opts.from ?? "user",
          to,
          assignee: opts.assignee,
          tool: opts.tool,
          worktreePath: opts.worktree,
          kind: (opts.kind as MessageKind) ?? "request",
          body,
          title: opts.title,
        });
        console.log(`thread ${result.thread.id}`);
        console.log(`message ${result.message.id}`);
        if (Array.isArray(result.deliveredTo) && result.deliveredTo.length > 0) {
          console.log(`delivered ${result.deliveredTo.join(",")}`);
        }
        return;
      } catch {
        const result = opts.thread
          ? sendThreadMessage({
              threadId: opts.thread,
              from: opts.from ?? "user",
              to,
              kind: (opts.kind as MessageKind) ?? "request",
              body,
            })
          : sendDirectMessage({
              from: opts.from ?? "user",
              to: to ?? [],
              body,
              title: opts.title,
              kind: (opts.kind as any) ?? "request",
            });
        console.log(`thread ${result.thread.id}`);
        console.log(`message ${result.message.id}`);
      }
    },
  );

const handoffCmd = program.command("handoff").description("Send an explicit orchestration handoff");

handoffCmd
  .command("send")
  .description("Open a handoff thread and transfer ownership/context to another agent")
  .argument("<body>")
  .option("--to <ids>", "Comma-separated recipient session ids")
  .option("--assignee <role>", "Route to a role if no explicit session id is provided")
  .option("--tool <tool>", "Route to a tool if no explicit session id is provided")
  .option("--worktree <path>", "Prefer a target in this worktree")
  .option("--from <sessionId>", "Sender session id", "user")
  .option("--title <title>", "Handoff thread title")
  .action(
    async (
      body: string,
      opts: { to?: string; assignee?: string; tool?: string; worktree?: string; from?: string; title?: string },
    ) => {
      const to = opts.to
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if ((!to || to.length === 0) && !opts.assignee && !opts.tool) {
        console.error("aimux: handoff send requires --to, --assignee, or --tool");
        process.exit(1);
      }
      try {
        const result = await postProjectServiceJson("/handoff", {
          from: opts.from ?? "user",
          to,
          assignee: opts.assignee,
          tool: opts.tool,
          body,
          title: opts.title,
          worktreePath: opts.worktree,
        });
        console.log(`thread ${result.thread.id}`);
        console.log(`message ${result.message.id}`);
        if (Array.isArray(result.deliveredTo) && result.deliveredTo.length > 0) {
          console.log(`delivered ${result.deliveredTo.join(",")}`);
        }
        return;
      } catch {
        const result = sendHandoff({
          from: opts.from ?? "user",
          to: to ?? [],
          body,
          title: opts.title,
          worktreePath: opts.worktree,
        });
        console.log(`thread ${result.thread.id}`);
        console.log(`message ${result.message.id}`);
      }
    },
  );

handoffCmd
  .command("accept")
  .description("Accept an existing handoff thread")
  .argument("<threadId>")
  .option("--from <sessionId>", "Accepting session id", "user")
  .option("--body <text>", "Optional acceptance note")
  .action(async (threadId: string, opts: { from?: string; body?: string }) => {
    try {
      const result = await postProjectServiceJson("/handoff/accept", {
        threadId,
        from: opts.from ?? "user",
        body: opts.body,
      });
      console.log(`thread ${result.thread.id}`);
      console.log(`message ${result.message.id}`);
      return;
    } catch {
      const result = acceptHandoff({
        threadId,
        from: opts.from ?? "user",
        body: opts.body,
      });
      console.log(`thread ${result.thread.id}`);
      console.log(`message ${result.message.id}`);
    }
  });

handoffCmd
  .command("complete")
  .description("Complete an existing handoff thread")
  .argument("<threadId>")
  .option("--from <sessionId>", "Completing session id", "user")
  .option("--body <text>", "Optional completion note")
  .action(async (threadId: string, opts: { from?: string; body?: string }) => {
    try {
      const result = await postProjectServiceJson("/handoff/complete", {
        threadId,
        from: opts.from ?? "user",
        body: opts.body,
      });
      console.log(`thread ${result.thread.id}`);
      console.log(`message ${result.message.id}`);
      return;
    } catch {
      const result = completeHandoff({
        threadId,
        from: opts.from ?? "user",
        body: opts.body,
      });
      console.log(`thread ${result.thread.id}`);
      console.log(`message ${result.message.id}`);
    }
  });

const taskCmd = program.command("task").description("Create and manage orchestrated tasks");

taskCmd
  .command("assign")
  .description("Create a durable task assignment")
  .argument("<description>")
  .option("--from <sessionId>", "Assigning session id", "user")
  .option("--to <sessionId>", "Specific assignee session id")
  .option("--assignee <role>", "Role name to route to")
  .option("--tool <tool>", "Tool key to route to")
  .option("--prompt <text>", "Full task prompt")
  .option("--type <type>", "task|review", "task")
  .option("--diff <text>", "Optional diff snippet or review payload")
  .option("--worktree <path>", "Associated worktree path")
  .action(
    async (
      description: string,
      opts: {
        from?: string;
        to?: string;
        assignee?: string;
        tool?: string;
        prompt?: string;
        type?: "task" | "review";
        diff?: string;
        worktree?: string;
      },
    ) => {
      try {
        const result = await postProjectServiceJson("/tasks/assign", {
          from: opts.from ?? "user",
          to: opts.to,
          assignee: opts.assignee,
          tool: opts.tool,
          description,
          prompt: opts.prompt,
          type: opts.type,
          diff: opts.diff,
          worktreePath: opts.worktree,
        });
        console.log(`task ${result.task.id}`);
        if (result.thread?.id) console.log(`thread ${result.thread.id}`);
        return;
      } catch {
        const result = await assignTask({
          from: opts.from ?? "user",
          to: opts.to,
          assignee: opts.assignee,
          tool: opts.tool,
          description,
          prompt: opts.prompt,
          type: opts.type,
          diff: opts.diff,
          worktreePath: opts.worktree,
        });
        console.log(`task ${result.task.id}`);
        if (result.thread?.id) console.log(`thread ${result.thread.id}`);
      }
    },
  );

worktreeCmd
  .command("list")
  .description("List all git worktrees")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const worktrees = listWorktrees(projectRoot);
    if (opts.json) {
      console.log(JSON.stringify(worktrees, null, 2));
      return;
    }
    printWorktrees(projectRoot);
  });

worktreeCmd
  .command("create <name>")
  .description("Create a git worktree")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (name: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      const createdPath = createWorktree(name, projectRoot);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              name,
              path: createdPath,
              projectRoot,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Created worktree "${name}" at ${createdPath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("spawn")
  .description("Spawn a fresh agent session using the same flow as the dashboard")
  .requiredOption("--tool <toolKey>", "Configured target tool key, e.g. claude or codex")
  .option("--project <path>", "Project path")
  .option("--worktree <path>", "Target worktree path")
  .option("--no-open", "Do not switch into the spawned agent window")
  .option("--json", "Emit JSON")
  .action(async (opts: { tool: string; project?: string; worktree?: string; open?: boolean; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      initProject();
      const mux = new Multiplexer();
      const targetWorktreePath = opts.worktree ? pathResolve(opts.worktree) : undefined;
      const result = await mux.spawnAgent({
        toolConfigKey: opts.tool,
        targetWorktreePath,
        open: opts.open,
      });
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              tool: opts.tool,
              worktreePath: targetWorktreePath ?? projectRoot,
              opened: opts.open !== false,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`spawned ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("fork")
  .description("Fork an existing agent into a new agent with handed-off context")
  .argument("<sourceSessionId>", "Source session id to fork from")
  .requiredOption("--tool <toolKey>", "Configured target tool key, e.g. claude or codex")
  .option("--project <path>", "Project path")
  .option("--instruction <text>", "Extra instruction for the forked agent")
  .option("--worktree <path>", "Target worktree path")
  .option("--no-open", "Do not switch into the forked agent window")
  .option("--json", "Emit JSON")
  .action(
    async (
      sourceSessionId: string,
      opts: { tool: string; project?: string; instruction?: string; worktree?: string; open?: boolean; json?: boolean },
    ) => {
      try {
        const projectRoot = await prepareProjectContext(opts.project);
        await ensureDaemonProjectReady(projectRoot);
        initProject();
        const mux = new Multiplexer();
        const targetWorktreePath = opts.worktree ? pathResolve(opts.worktree) : undefined;
        const result = await mux.forkAgent({
          sourceSessionId,
          targetToolConfigKey: opts.tool,
          instruction: opts.instruction,
          targetWorktreePath,
          open: opts.open,
        });
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                projectRoot,
                sourceSessionId,
                sessionId: result.sessionId,
                threadId: result.threadId,
                tool: opts.tool,
                worktreePath: targetWorktreePath ?? projectRoot,
                opened: opts.open !== false,
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(`forked ${result.sessionId}`);
        console.log(`thread ${result.threadId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );

const graveyardCmd = program.command("graveyard").description("Manage killed agents (recoverable)");

graveyardCmd
  .command("list")
  .description("List agents in the graveyard")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    await prepareProjectContext(opts.project);
    const graveyardPath = getGraveyardPath();
    try {
      const graveyard = JSON.parse(readFileSync(graveyardPath, "utf-8"));
      if (opts.json) {
        console.log(JSON.stringify(Array.isArray(graveyard) ? graveyard : [], null, 2));
        return;
      }
      if (!Array.isArray(graveyard) || graveyard.length === 0) {
        console.log("Graveyard is empty.");
        return;
      }
      console.log("ID".padEnd(25) + "Tool".padEnd(15) + "Backend Session ID");
      console.log("-".repeat(70));
      for (const s of graveyard) {
        console.log(
          (s.id ?? "?").padEnd(25) + (s.command ?? s.tool ?? "?").padEnd(15) + (s.backendSessionId ?? "(none)"),
        );
      }
    } catch {
      if (opts.json) {
        console.log("[]");
        return;
      }
      console.log("Graveyard is empty.");
    }
  });

graveyardCmd
  .command("send <id>")
  .description("Send an agent to the graveyard from running or offline state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (id: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      const mux = new Multiplexer();
      const result = await mux.sendAgentToGraveyard(id);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              status: result.status,
              previousStatus: result.previousStatus,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`graveyarded ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

graveyardCmd
  .command("resurrect <id>")
  .description("Resurrect an agent from the graveyard back to offline state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (id: string, opts: { project?: string; json?: boolean }) => {
    await prepareProjectContext(opts.project);
    const graveyardPath = getGraveyardPath();
    if (!existsSync(graveyardPath)) {
      console.error("Graveyard is empty.");
      process.exit(1);
    }
    try {
      const graveyard = JSON.parse(readFileSync(graveyardPath, "utf-8")) as Array<Record<string, unknown>>;
      const idx = graveyard.findIndex((s) => s.id === id);
      if (idx === -1) {
        console.error(`Agent "${id}" not found in graveyard.`);
        process.exit(1);
      }
      const restored = graveyard.splice(idx, 1)[0];
      writeFileSync(graveyardPath, JSON.stringify(graveyard, null, 2) + "\n");

      const statePath = getStatePath();
      let state = {
        savedAt: new Date().toISOString(),
        cwd: process.cwd(),
        sessions: [] as Array<Record<string, unknown>>,
      };
      if (existsSync(statePath)) {
        try {
          state = JSON.parse(readFileSync(statePath, "utf-8"));
        } catch {}
      }
      state.sessions.push(restored);
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              sessionId: id,
              status: "offline",
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Resurrected "${id}". It will appear as offline next time you start aimux.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("stop <sessionId>")
  .description("Stop a running agent and move it to offline state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      const mux = new Multiplexer();
      const result = await mux.stopAgent(sessionId);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              status: result.status,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`stopped ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("rename <sessionId>")
  .description("Rename an agent label in running or offline state")
  .requiredOption("--label <label>", "New agent label")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string, opts: { label: string; project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      const mux = new Multiplexer();
      const result = await mux.renameAgent(sessionId, opts.label);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              label: result.label,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`renamed ${result.sessionId} -> ${result.label ?? ""}`.trim());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("kill <sessionId>")
  .description("Send an agent to the graveyard from running or offline state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      const mux = new Multiplexer();
      const result = await mux.sendAgentToGraveyard(sessionId);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              status: result.status,
              previousStatus: result.previousStatus,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`graveyarded ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("migrate <sessionId>")
  .description("Migrate a running agent into another worktree")
  .requiredOption("--worktree <path>", "Target worktree path")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string, opts: { worktree: string; project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      const mux = new Multiplexer();
      const targetWorktreePath = pathResolve(opts.worktree);
      const result = await mux.migrateAgentSession(sessionId, targetWorktreePath);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              worktreePath: result.worktreePath ?? projectRoot,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`migrated ${result.sessionId} -> ${result.worktreePath ?? projectRoot}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

// ── Statusline commands ────────────────────────────────────────────

const statuslineCmd = program.command("statusline").description("Manage Claude Code statusline integration");

program
  .command("tmux-statusline")
  .description("Internal tmux status line renderer")
  .option("--line <line>", "Status line row", "bottom")
  .option("--project-root <path>", "Project root to read status from", process.cwd())
  .option("--current-window <name>", "Current tmux window name")
  .option("--current-window-id <id>", "Current tmux window id")
  .option("--current-path <path>", "Current pane path")
  .option("--current-session <name>", "Current tmux session name")
  .option("--width <n>", "Current client width")
  .action(
    async (opts: {
      line: TmuxStatusLine;
      projectRoot: string;
      currentWindow?: string;
      currentWindowId?: string;
      currentPath?: string;
      currentSession?: string;
      width?: string;
    }) => {
      await initPaths(opts.projectRoot);
      process.stdout.write(
        renderTmuxStatusline(opts.projectRoot, opts.line, {
          currentWindow: opts.currentWindow,
          currentWindowId: opts.currentWindowId,
          currentPath: opts.currentPath,
          currentSession: opts.currentSession,
          width: opts.width ? Number(opts.width) : undefined,
        }),
      );
    },
  );

program
  .command("tmux-switch <action>")
  .description("Internal scoped tmux switcher")
  .option("--project-root <path>", "Project root", process.cwd())
  .option("--current-window <name>", "Current tmux window name")
  .option("--current-path <path>", "Current pane path", process.cwd())
  .action(async (action: string, opts: { projectRoot: string; currentWindow?: string; currentPath: string }) => {
    await initPaths(opts.projectRoot);
    const tmux = new TmuxRuntimeManager();
    const tmuxSession = tmux.getProjectSession(opts.projectRoot);
    const managed = tmux
      .listManagedWindows(tmuxSession.sessionName)
      .filter(({ target, metadata }) => {
        if (isDashboardWindowName(target.windowName)) return false;
        if (action === "attention") return true;
        if (opts.currentWindow && isDashboardWindowName(opts.currentWindow)) return false;
        const worktreePath = metadata.worktreePath || opts.projectRoot;
        return worktreePath === opts.currentPath;
      })
      .sort((a, b) => a.target.windowIndex - b.target.windowIndex);

    if (managed.length === 0) return;
    const metadataState = loadMetadataState(opts.projectRoot);

    const urgency = (sessionId: string): number => {
      const derived = metadataState.sessions[sessionId]?.derived;
      if (!derived) return 0;
      if (derived.attention === "error") return 5;
      if (derived.attention === "needs_input") return 4;
      if (derived.attention === "blocked") return 3;
      if ((derived.unseenCount ?? 0) > 0) return 2;
      if (derived.activity === "done") return 1;
      return 0;
    };

    if (action === "attention") {
      const candidates = managed
        .map((entry) => ({ ...entry, urgency: urgency(entry.metadata.sessionId) }))
        .filter((entry) => entry.urgency > 0)
        .sort((a, b) => b.urgency - a.urgency || a.target.windowIndex - b.target.windowIndex);
      if (candidates.length === 0) return;
      const nonCurrent = candidates.find(
        ({ target, metadata }) => target.windowName !== opts.currentWindow && metadata.label !== opts.currentWindow,
      );
      tmux.selectWindow((nonCurrent ?? candidates[0])!.target);
      return;
    }

    const currentIndex = managed.findIndex(({ target, metadata }) => {
      return target.windowName === opts.currentWindow || metadata.label === opts.currentWindow;
    });
    const resolvedIndex = currentIndex >= 0 ? currentIndex : 0;

    if (action === "next") {
      tmux.selectWindow(managed[(resolvedIndex + 1) % managed.length]!.target);
      return;
    }
    if (action === "prev") {
      tmux.selectWindow(managed[(resolvedIndex - 1 + managed.length) % managed.length]!.target);
      return;
    }
    if (action === "menu") {
      tmux.displayWindowMenu(
        "aimux",
        managed.map(({ target, metadata }, index) => ({
          label:
            index === resolvedIndex
              ? `${metadata.label || metadata.command}*`
              : `${metadata.label || metadata.command}`,
          target,
        })),
      );
      return;
    }
  });

const doctorCmd = program.command("doctor").description("Inspect aimux runtime compatibility");

doctorCmd
  .command("tmux")
  .description("Inspect managed tmux session compatibility state")
  .option("--project-root <path>", "Project root", process.cwd())
  .option("--session <name>", "Managed tmux session name override")
  .option("--window-id <id>", "Specific tmux window id to inspect")
  .option("--json", "Emit JSON")
  .action(async (opts: { projectRoot: string; session?: string; windowId?: string; json?: boolean }) => {
    await initPaths(opts.projectRoot);
    const tmux = new TmuxRuntimeManager();
    const report = buildTmuxDoctorReport(tmux, {
      projectRoot: opts.projectRoot,
      sessionName: opts.session,
      windowId: opts.windowId,
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderTmuxDoctorReport(report));
  });

const metadataCmd = program.command("metadata").description("Push metadata into aimux tmux status integration");
const metadataTracker = new AgentTracker();

metadataCmd
  .command("endpoint")
  .description("Print the local metadata API endpoint")
  .action(async () => {
    await initPaths();
    const endpoint = loadMetadataEndpoint();
    if (!endpoint) {
      console.error("aimux metadata API is not running for this project");
      process.exit(1);
    }
    console.log(`http://${endpoint.host}:${endpoint.port}`);
  });

metadataCmd
  .command("event <session> <kind>")
  .option("--message <message>", "Event message")
  .option("--source <source>", "Event source")
  .option("--tone <tone>", "Event tone")
  .option("--thread-id <threadId>", "Thread identifier")
  .option("--thread-name <threadName>", "Thread name")
  .description("Emit a normalized agent event")
  .action(
    async (
      session: string,
      kind: AgentEventKind,
      opts: {
        message?: string;
        source?: string;
        tone?: MetadataTone;
        threadId?: string;
        threadName?: string;
      },
    ) => {
      await initPaths();
      metadataTracker.emit(session, {
        kind,
        message: opts.message,
        source: opts.source,
        tone: opts.tone,
        threadId: opts.threadId,
        threadName: opts.threadName,
      });
    },
  );

metadataCmd
  .command("mark-seen <session>")
  .description("Mark a session's unseen activity as seen")
  .action(async (session: string) => {
    await initPaths();
    metadataTracker.markSeen(session);
  });

metadataCmd
  .command("set-activity <session> <activity>")
  .description("Set derived activity state for a session")
  .action(async (session: string, activity: AgentActivityState) => {
    await initPaths();
    metadataTracker.setActivity(session, activity);
  });

metadataCmd
  .command("set-attention <session> <attention>")
  .description("Set derived attention state for a session")
  .action(async (session: string, attention: AgentAttentionState) => {
    await initPaths();
    metadataTracker.setAttention(session, attention);
  });

metadataCmd
  .command("set-status <session> <text>")
  .option("--tone <tone>", "Status tone", "info")
  .description("Set a session status pill")
  .action(async (session: string, text: string, opts: { tone?: MetadataTone }) => {
    await initPaths();
    updateSessionMetadata(session, (current) => ({
      ...current,
      status: { text, tone: opts.tone },
    }));
  });

metadataCmd
  .command("set-progress <session> <current> <total>")
  .option("--label <label>", "Progress label")
  .description("Set per-session progress")
  .action(async (session: string, current: string, total: string, opts: { label?: string }) => {
    await initPaths();
    updateSessionMetadata(session, (existing) => ({
      ...existing,
      progress: { current: Number(current), total: Number(total), label: opts.label },
    }));
  });

metadataCmd
  .command("set-context <session>")
  .option("--cwd <cwd>", "Working directory")
  .option("--worktree-path <path>", "Worktree path")
  .option("--worktree-name <name>", "Worktree name")
  .option("--branch <branch>", "Git branch")
  .option("--pr-number <number>", "PR number")
  .option("--pr-title <title>", "PR title")
  .option("--pr-url <url>", "PR URL")
  .description("Set rich session context metadata")
  .action(
    async (
      session: string,
      opts: {
        cwd?: string;
        worktreePath?: string;
        worktreeName?: string;
        branch?: string;
        prNumber?: string;
        prTitle?: string;
        prUrl?: string;
      },
    ) => {
      await initPaths();
      const context: SessionContextMetadata = {
        cwd: opts.cwd,
        worktreePath: opts.worktreePath,
        worktreeName: opts.worktreeName,
        branch: opts.branch,
        pr:
          opts.prNumber || opts.prTitle || opts.prUrl
            ? {
                number: opts.prNumber ? Number(opts.prNumber) : undefined,
                title: opts.prTitle,
                url: opts.prUrl,
              }
            : undefined,
      };
      updateSessionMetadata(session, (existing) => ({
        ...existing,
        context: {
          ...(existing.context ?? {}),
          ...context,
          pr: {
            ...(existing.context?.pr ?? {}),
            ...(context.pr ?? {}),
          },
        },
      }));
    },
  );

metadataCmd
  .command("set-services <session>")
  .requiredOption("--url <url...>", "One or more service URLs")
  .option("--label <label>", "Shared label for the services")
  .description("Set detected session services/ports")
  .action(async (session: string, opts: { url: string[]; label?: string }) => {
    await initPaths();
    const services: SessionServiceMetadata[] = (opts.url ?? []).map((url) => {
      const match = url.match(/:(\d+)(?:\/|$)/);
      return {
        label: opts.label,
        url,
        port: match ? Number(match[1]) : undefined,
      };
    });
    updateSessionMetadata(session, (existing) => ({
      ...existing,
      derived: {
        ...(existing.derived ?? {}),
        services,
      },
    }));
  });

metadataCmd
  .command("log <session> <message>")
  .option("--source <source>", "Log source")
  .option("--tone <tone>", "Log tone")
  .description("Append a session log line")
  .action(async (session: string, message: string, opts: { source?: string; tone?: MetadataTone }) => {
    await initPaths();
    updateSessionMetadata(session, (existing) => ({
      ...existing,
      logs: [
        ...(existing.logs ?? []).slice(-19),
        { message, source: opts.source, tone: opts.tone, ts: new Date().toISOString() },
      ],
    }));
  });

metadataCmd
  .command("clear-log <session>")
  .description("Clear session logs")
  .action(async (session: string) => {
    await initPaths();
    clearSessionLogs(session);
  });

statuslineCmd
  .command("install")
  .description("Install aimux statusline into Claude Code")
  .action(() => {
    const home = homedir();
    const aimuxDir = pathJoin(home, ".aimux");
    const targetScript = pathJoin(aimuxDir, "statusline.sh");

    // Resolve source script relative to compiled JS location
    const thisFile = fileURLToPath(import.meta.url);
    const sourceScript = pathResolve(pathDirname(thisFile), "..", "scripts", "statusline.sh");

    if (!existsSync(sourceScript)) {
      console.error(`Source script not found: ${sourceScript}`);
      process.exit(1);
    }
    mkdirSync(aimuxDir, { recursive: true });
    copyFileSync(sourceScript, targetScript);
    chmodSync(targetScript, 0o755);
    console.log(`Copied statusline script to ${targetScript}`);

    // Update Claude Code settings
    const claudeDir = pathJoin(home, ".claude");
    const settingsPath = pathJoin(claudeDir, "settings.json");
    let settings: Record<string, any> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {}
    }

    const newCommand = `bash ${targetScript}`;
    const oldCommand = settings.statusLine?.command;
    if (oldCommand && oldCommand !== newCommand) {
      const backupPath = pathJoin(aimuxDir, "statusline-previous.txt");
      writeFileSync(backupPath, oldCommand + "\n");
      console.log(`Backed up previous statusline command to ${backupPath}`);
    }

    settings.statusLine = { type: "command", command: newCommand };
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`Updated ${settingsPath} → statusLine points to aimux script`);
    console.log("Restart Claude Code to see aimux agent status in the toolbar.");
  });

statuslineCmd
  .command("uninstall")
  .description("Restore previous Claude Code statusline")
  .action(() => {
    const home = homedir();
    const aimuxDir = pathJoin(home, ".aimux");
    const settingsPath = pathJoin(home, ".claude", "settings.json");
    const backupPath = pathJoin(aimuxDir, "statusline-previous.txt");

    if (!existsSync(settingsPath)) {
      console.error("No Claude Code settings found.");
      process.exit(1);
    }

    let settings: Record<string, any> = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error("Could not parse settings.json");
      process.exit(1);
    }

    if (existsSync(backupPath)) {
      const prev = readFileSync(backupPath, "utf-8").trim();
      settings.statusLine = { type: "command", command: prev };
      console.log(`Restored previous statusline: ${prev}`);
    } else {
      delete settings.statusLine;
      console.log("Removed aimux statusline (no previous config to restore).");
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("Restart Claude Code for changes to take effect.");
  });

// ── Team commands ──────────────────────────────────────────────────

const teamCmd = program.command("team").description("Manage agent team roles");

teamCmd
  .command("show")
  .description("Show current team config")
  .action(() => {
    const config = loadTeamConfig();
    console.log("Team Roles:");
    for (const [name, role] of Object.entries(config.roles) as [string, any][]) {
      const flags: string[] = [];
      if (role.reviewedBy) flags.push(`reviewed by: ${role.reviewedBy}`);
      if (role.canEdit) flags.push("can edit");
      const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      console.log(`  ${name}: ${role.description}${flagStr}`);
    }
    console.log(`\nDefault role: ${config.defaultRole}`);
  });

teamCmd
  .command("add <role>")
  .description("Add or update a role")
  .option("-d, --description <desc>", "Role description")
  .option("--reviewed-by <role>", "Role that reviews this role's work")
  .option("--can-edit", "Whether this role can edit code directly")
  .action((role: string, options: { description?: string; reviewedBy?: string; canEdit?: boolean }) => {
    const config = loadTeamConfig();
    config.roles[role] = {
      description: options.description ?? config.roles[role]?.description ?? `${role} agent`,
      ...(options.reviewedBy && { reviewedBy: options.reviewedBy }),
      ...(options.canEdit && { canEdit: true }),
    };
    saveTeamConfig(config);
    console.log(`Role "${role}" saved.`);
  });

teamCmd
  .command("remove <role>")
  .description("Remove a role")
  .action((role: string) => {
    const config = loadTeamConfig();
    if (!config.roles[role]) {
      console.error(`Role "${role}" not found.`);
      process.exit(1);
    }
    delete config.roles[role];
    if (config.defaultRole === role) {
      config.defaultRole = Object.keys(config.roles)[0] ?? "coder";
    }
    saveTeamConfig(config);
    console.log(`Role "${role}" removed.`);
  });

teamCmd
  .command("default <role>")
  .description("Set the default role for new agents")
  .action((role: string) => {
    const config = loadTeamConfig();
    if (!config.roles[role]) {
      console.error(`Role "${role}" not found. Add it first with: aimux team add ${role}`);
      process.exit(1);
    }
    config.defaultRole = role;
    saveTeamConfig(config);
    console.log(`Default role set to "${role}".`);
  });

teamCmd
  .command("init")
  .description("Initialize project with default team structure")
  .action(() => {
    const config = getDefaultTeamConfig();
    saveTeamConfig(config);
    console.log("Team config initialized with default roles:");
    for (const [name, role] of Object.entries(config.roles) as [string, any][]) {
      console.log(`  ${name}: ${role.description}`);
    }
  });

program.parse();
