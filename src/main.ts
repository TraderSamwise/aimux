import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { Multiplexer } from "./multiplexer.js";
import { llmCompact } from "./context/compactor.js";
import { getHistoryDir } from "./context/history.js";
import { getAimuxDir, initProject } from "./config.js";
import { createWorktree, listWorktrees, cleanWorktrees, removeWorktree } from "./worktree.js";

const program = new Command();

program
  .name("aimux")
  .description("Native CLI agent multiplexer")
  .version("0.1.0")
  .argument("[tool]", "Tool to run (e.g. claude, codex, aider)")
  .argument("[args...]", "Arguments to pass to the tool")
  .option("--resume", "Resume previous sessions using native tool resume")
  .option("--restore", "Start fresh sessions with injected history context")
  .action(async (tool: string | undefined, args: string[], opts: { resume?: boolean; restore?: boolean }) => {
    const mux = new Multiplexer();

    // Graceful shutdown on signals
    const shutdown = () => {
      mux.cleanup();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

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
      process.exit(exitCode);
    } catch (err: unknown) {
      mux.cleanup();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`aimux: failed to spawn "${tool}": ${msg}`);
      process.exit(1);
    }
  });

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
    console.log(`Done. Summary written to ${getAimuxDir()}/context/summary.md`);
  });

const worktreeCmd = program
  .command("worktree")
  .description("Manage git worktrees");

worktreeCmd
  .command("create <name>")
  .description("Create a new worktree as a sibling directory")
  .option("-b, --branch <branch>", "Branch name (defaults to worktree name)")
  .action((name: string, opts: { branch?: string }) => {
    try {
      const info = createWorktree(name, opts.branch);
      console.log(`Created worktree "${info.name}" at ${info.path} (branch: ${info.branch})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

worktreeCmd
  .command("list")
  .description("List all known worktrees")
  .action(() => {
    try {
      const worktrees = listWorktrees();
      if (worktrees.length === 0) {
        console.log("No worktrees found.");
        return;
      }
      console.log(
        "Name".padEnd(20) +
        "Branch".padEnd(20) +
        "Status".padEnd(10) +
        "Sessions".padEnd(10) +
        "Path"
      );
      console.log("-".repeat(80));
      for (const wt of worktrees) {
        console.log(
          wt.name.padEnd(20) +
          wt.branch.padEnd(20) +
          wt.status.padEnd(10) +
          String(wt.sessions.length).padEnd(10) +
          wt.path
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

worktreeCmd
  .command("clean")
  .description("Remove offline worktrees with no active sessions")
  .action(() => {
    try {
      const removed = cleanWorktrees();
      if (removed.length === 0) {
        console.log("No worktrees to clean.");
      } else {
        console.log(`Removed ${removed.length} worktree(s): ${removed.join(", ")}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

worktreeCmd
  .command("remove <name>")
  .description("Remove a specific worktree")
  .action((name: string) => {
    try {
      removeWorktree(name);
      console.log(`Removed worktree "${name}".`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

const trashCmd = program
  .command("trash")
  .description("Manage trashed (killed) agents");

trashCmd
  .command("list")
  .description("List trashed agents")
  .action(() => {
    const trashPath = `${getAimuxDir()}/state-trash.json`;
    try {
      const trash = JSON.parse(readFileSync(trashPath, "utf-8"));
      if (!Array.isArray(trash) || trash.length === 0) {
        console.log("No trashed agents.");
        return;
      }
      console.log("ID".padEnd(25) + "Tool".padEnd(15) + "Backend Session ID");
      console.log("-".repeat(70));
      for (const s of trash) {
        console.log(
          (s.id ?? "?").padEnd(25) +
          (s.command ?? s.tool ?? "?").padEnd(15) +
          (s.backendSessionId ?? "(none)")
        );
      }
    } catch {
      console.log("No trashed agents.");
    }
  });

trashCmd
  .command("restore <id>")
  .description("Restore a trashed agent back to offline state")
  .action((id: string) => {
    const dir = getAimuxDir();
    const trashPath = `${dir}/state-trash.json`;
    if (!existsSync(trashPath)) {
      console.error("No trash file found.");
      process.exit(1);
    }
    try {
      const trash = JSON.parse(readFileSync(trashPath, "utf-8")) as Array<Record<string, unknown>>;
      const idx = trash.findIndex(s => s.id === id);
      if (idx === -1) {
        console.error(`Agent "${id}" not found in trash.`);
        process.exit(1);
      }
      const restored = trash.splice(idx, 1)[0];
      writeFileSync(trashPath, JSON.stringify(trash, null, 2) + "\n");

      // Add back to state.json
      const statePath = `${dir}/state.json`;
      let state = { savedAt: new Date().toISOString(), cwd: process.cwd(), sessions: [] as Array<Record<string, unknown>> };
      if (existsSync(statePath)) {
        try { state = JSON.parse(readFileSync(statePath, "utf-8")); } catch {}
      }
      state.sessions.push(restored);
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      console.log(`Restored "${id}". It will appear as offline next time you start aimux.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program.parse();
