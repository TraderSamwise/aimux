import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { join as pathJoin, resolve as pathResolve, dirname as pathDirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Multiplexer } from "./multiplexer.js";
import { llmCompact } from "./context/compactor.js";
import { initProject } from "./config.js";
import { loadConfig } from "./config.js";
import { initPaths, getHistoryDir, getGraveyardPath, getStatePath, getContextDir } from "./paths.js";
import { loadTeamConfig, saveTeamConfig, getDefaultTeamConfig } from "./team.js";
import { createWorktree, listWorktrees } from "./worktree.js";
import { startServerForeground, stopServer, getServerStatus, isServerRunning } from "./server.js";
import { TmuxRuntimeManager } from "./tmux-runtime-manager.js";

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
      const runtimeConfig = loadConfig().runtime;
      if (runtimeConfig.backend === "tmux" && !opts.tmuxDashboardInternal) {
        initProject();
        const tmux = new TmuxRuntimeManager();
        if (!tmux.isAvailable()) {
          console.error("aimux: tmux backend selected but tmux is not installed or not available in PATH");
          process.exit(1);
        }
        if (runtimeConfig.tmux.mode !== "managed-session") {
          console.error('aimux: tmux runtime currently supports only runtime.tmux.mode = "managed-session"');
          process.exit(1);
        }

        const scriptPath = fileURLToPath(import.meta.url);
        const dashboardCommand = {
          cwd: process.cwd(),
          command: process.execPath,
          args: [scriptPath, "--tmux-dashboard-internal"],
        };
        const dashboardSession = tmux.ensureProjectSession(process.cwd(), {
          cwd: dashboardCommand.cwd,
          command: dashboardCommand.command,
          args: dashboardCommand.args,
        });
        const dashboardTarget = tmux.ensureDashboardWindow(
          dashboardSession.sessionName,
          process.cwd(),
          dashboardCommand,
        );
        tmux.respawnWindow(dashboardTarget, dashboardCommand);
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

// ── Server commands ────────────────────────────────────────────────

const serverCmd = program.command("server").description("Manage aimux server (headless persistent agent host)");

serverCmd
  .command("start")
  .description("Start the aimux server as a background daemon")
  .option("--foreground", "Run in foreground (used internally)")
  .action(async (opts: { foreground?: boolean }) => {
    if (opts.foreground) {
      await startServerForeground();
      return;
    }

    if (isServerRunning()) {
      console.log("Server is already running.");
      process.exit(0);
    }

    const child = spawn(process.argv[0], [process.argv[1], "server", "start", "--foreground"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`Server started (PID ${child.pid}).`);
  });

serverCmd
  .command("stop")
  .description("Stop the running aimux server")
  .action(() => {
    if (stopServer()) {
      console.log("Server stopped.");
    } else {
      console.error("No running server found.");
      process.exit(1);
    }
  });

serverCmd
  .command("status")
  .description("Check if the aimux server is running")
  .action(() => {
    const status = getServerStatus();
    if (status.running) {
      console.log(`Server is running (PID ${status.pid}).`);
    } else {
      console.log("Server is not running.");
    }
  });

program.parse();
