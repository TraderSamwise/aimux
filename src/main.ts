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
import { TmuxRuntimeManager } from "./tmux-runtime-manager.js";
import { renderTmuxStatusline, type TmuxStatusLine } from "./tmux-statusline.js";
import {
  loadMetadataEndpoint,
  updateSessionMetadata,
  clearSessionLogs,
  type MetadataTone,
  type SessionContextMetadata,
} from "./metadata-store.js";
import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState, AgentAttentionState, AgentEventKind } from "./agent-events.js";

const program = new Command();

program
  .name("aimux")
  .description("Native CLI agent multiplexer")
  .version("0.1.0")
  .argument("[tool]", "Tool to run (e.g. claude, codex, aider)")
  .argument("[args...]", "Arguments to pass to the tool")
  .option("--resume", "Resume previous sessions using native tool resume")
  .option("--restore", "Start fresh sessions with injected history context")
  .option("--tmux-dashboard-internal", "Internal tmux dashboard entrypoint")
  .hook("preAction", async () => {
    await initPaths();
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
        const tmux = new TmuxRuntimeManager();
        if (!tmux.isAvailable()) {
          console.error("aimux: tmux is not installed or not available in PATH");
          process.exit(1);
        }

        const scriptPath = fileURLToPath(import.meta.url);
        const dashboardBuildStamp = String(statSync(scriptPath).mtimeMs);
        const dashboardCommand = {
          cwd: projectRoot,
          command: process.execPath,
          args: [scriptPath, "--tmux-dashboard-internal"],
        };
        const statuslineCommand = {
          command: process.execPath,
          args: [scriptPath, "tmux-statusline"],
        };
        const dashboardSession = tmux.ensureProjectSession(
          projectRoot,
          {
            cwd: dashboardCommand.cwd,
            command: dashboardCommand.command,
            args: dashboardCommand.args,
          },
          statuslineCommand,
        );
        const dashboardTarget = tmux.ensureDashboardWindow(dashboardSession.sessionName, projectRoot, dashboardCommand);
        const currentBuildStamp = tmux.getWindowOption(dashboardTarget, "@aimux-dashboard-build");
        const shouldRespawnDashboard =
          !tmux.isWindowAlive(dashboardTarget) || currentBuildStamp !== dashboardBuildStamp;
        if (shouldRespawnDashboard) {
          tmux.respawnWindow(dashboardTarget, dashboardCommand);
          tmux.setWindowOption(dashboardTarget, "@aimux-dashboard-build", dashboardBuildStamp);
        }
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
    let projectRoot = originalCwd;
    try {
      projectRoot = findMainRepo(originalCwd);
    } catch {}

    const tmux = new TmuxRuntimeManager();
    if (!tmux.isAvailable()) {
      console.error("aimux: tmux is not installed or not available in PATH");
      process.exit(1);
    }

    const scriptPath = fileURLToPath(import.meta.url);
    const dashboardBuildStamp = String(statSync(scriptPath).mtimeMs);
    const dashboardCommand = {
      cwd: projectRoot,
      command: process.execPath,
      args: [scriptPath, "--tmux-dashboard-internal"],
    };
    const statuslineCommand = {
      command: process.execPath,
      args: [scriptPath, "tmux-statusline"],
    };

    const dashboardSession = tmux.ensureProjectSession(projectRoot, dashboardCommand, statuslineCommand);
    const dashboardTarget = tmux.ensureDashboardWindow(dashboardSession.sessionName, projectRoot, dashboardCommand);
    tmux.respawnWindow(dashboardTarget, dashboardCommand);
    tmux.setWindowOption(dashboardTarget, "@aimux-dashboard-build", dashboardBuildStamp);

    if (opts.open) {
      tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux() });
      return;
    }

    console.log(`Reloaded dashboard for ${dashboardSession.sessionName}`);
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

function printWorktrees(): void {
  try {
    const worktrees = listWorktrees();
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

worktreeCmd
  .command("list")
  .description("List all git worktrees")
  .action(() => {
    printWorktrees();
  });

worktreeCmd
  .command("create <name>")
  .description("Create a git worktree")
  .action((name: string) => {
    try {
      const path = createWorktree(name);
      console.log(`Created worktree "${name}" at ${path}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

const graveyardCmd = program.command("graveyard").description("Manage killed agents (recoverable)");

graveyardCmd
  .command("list")
  .description("List agents in the graveyard")
  .action(() => {
    const graveyardPath = getGraveyardPath();
    try {
      const graveyard = JSON.parse(readFileSync(graveyardPath, "utf-8"));
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
      console.log("Graveyard is empty.");
    }
  });

graveyardCmd
  .command("resurrect <id>")
  .description("Resurrect an agent from the graveyard back to offline state")
  .action((id: string) => {
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
      console.log(`Resurrected "${id}". It will appear as offline next time you start aimux.`);
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
  .option("--current-path <path>", "Current pane path")
  .option("--current-session <name>", "Current tmux session name")
  .option("--width <n>", "Current client width")
  .action(
    async (opts: {
      line: TmuxStatusLine;
      projectRoot: string;
      currentWindow?: string;
      currentPath?: string;
      width?: string;
    }) => {
      await initPaths(opts.projectRoot);
      process.stdout.write(
        renderTmuxStatusline(opts.projectRoot, opts.line, {
          currentWindow: opts.currentWindow,
          currentPath: opts.currentPath,
          currentSession: (opts as { currentSession?: string }).currentSession,
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
    if (opts.currentWindow === "dashboard") return;
    const tmux = new TmuxRuntimeManager();
    const tmuxSession = tmux.getProjectSession(opts.projectRoot);
    const managed = tmux
      .listManagedWindows(tmuxSession.sessionName)
      .filter(({ target, metadata }) => {
        if (target.windowName === "dashboard" || target.windowIndex === 0) return false;
        const worktreePath = metadata.worktreePath || opts.projectRoot;
        return worktreePath === opts.currentPath;
      })
      .sort((a, b) => a.target.windowIndex - b.target.windowIndex);

    if (managed.length === 0) return;

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
  .description("Emit a normalized agent event")
  .action(
    async (session: string, kind: AgentEventKind, opts: { message?: string; source?: string; tone?: MetadataTone }) => {
      await initPaths();
      metadataTracker.emit(session, {
        kind,
        message: opts.message,
        source: opts.source,
        tone: opts.tone,
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
