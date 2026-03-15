import { Command } from "commander";
import { Multiplexer } from "./multiplexer.js";

const program = new Command();

program
  .name("aimux")
  .description("Native CLI agent multiplexer")
  .version("0.1.0")
  .argument("[tool]", "Tool to run (e.g. claude, codex, aider)")
  .argument("[args...]", "Arguments to pass to the tool")
  .action(async (tool: string | undefined, args: string[]) => {
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
      if (tool) {
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

program.parse();
