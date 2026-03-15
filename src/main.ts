import { Command } from "commander";
import { readdirSync } from "node:fs";
import { Multiplexer } from "./multiplexer.js";
import { llmCompact } from "./context/compactor.js";
import { getHistoryDir } from "./context/history.js";
import { getAimuxDir, initProject } from "./config.js";

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

program.parse();
