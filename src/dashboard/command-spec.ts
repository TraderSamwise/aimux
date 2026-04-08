import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import type { TmuxCommandSpec } from "../tmux/runtime-manager.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface DashboardCommandSpec {
  scriptPath: string;
  dashboardBuildStamp: string;
  dashboardCommand: TmuxCommandSpec;
}

function resolveDashboardScriptPath(): string {
  const compiledPath = fileURLToPath(new URL("../main.js", import.meta.url));
  if (existsSync(compiledPath)) return compiledPath;
  return fileURLToPath(new URL("../main.ts", import.meta.url));
}

export function getDashboardCommandSpec(projectRoot: string): DashboardCommandSpec {
  const scriptPath = resolveDashboardScriptPath();
  const wrappedDashboardCommand = [
    "output_file=$(mktemp /tmp/aimux-dashboard-output.XXXXXX)",
    ";",
    "set -o pipefail",
    ";",
    shellQuote(process.execPath),
    shellQuote(scriptPath),
    "--tmux-dashboard-internal",
    "2>&1",
    "|",
    "tee",
    '"$output_file"',
    "|",
    "tee",
    "-a",
    shellQuote("/tmp/aimux-debug.log"),
    ";",
    "code=$?",
    ";",
    "if",
    "[",
    "$code",
    "-ne",
    "0",
    "]",
    ";",
    "then",
    "printf",
    "'\\033[?1049l\\033[H\\033[2J'",
    ";",
    "if",
    "[",
    "-s",
    '"$output_file"',
    "]",
    ";",
    "then",
    "cat",
    '"$output_file"',
    ";",
    "else",
    "printf",
    "%s\\n%s\\n",
    shellQuote("No dashboard stderr/stdout was captured."),
    shellQuote("Last debug log lines:"),
    ";",
    "tail",
    "-n",
    "40",
    shellQuote("/tmp/aimux-debug.log"),
    ";",
    "fi",
    ";",
    "printf",
    "%s\\n",
    shellQuote(""),
    ";",
    "printf",
    "%s\\n%s\\n%s\\n%s\\n%s\\n",
    shellQuote("aimux dashboard failed to start."),
    shellQuote("The error above was captured from the dashboard process."),
    shellQuote("If that output is empty, the last debug-log lines were shown instead."),
    shellQuote("Press q, Enter, or Ctrl+C to close this pane."),
    shellQuote(""),
    ";",
    "printf",
    "%s\\n",
    '"exit code: $code"',
    ";",
    "while",
    "IFS= read -rsn1 key",
    ";",
    "do",
    "if",
    "[",
    "-z",
    '"$key"',
    "]",
    "||",
    "[",
    '"$key"',
    "=",
    shellQuote("q"),
    "]",
    ";",
    "then",
    "rm",
    "-f",
    '"$output_file"',
    ";",
    "exit 0",
    ";",
    "fi",
    ";",
    "done",
    ";",
    "else",
    "rm",
    "-f",
    '"$output_file"',
    ";",
    "fi",
  ].join(" ");
  return {
    scriptPath,
    dashboardBuildStamp: String(statSync(scriptPath).mtimeMs),
    dashboardCommand: {
      cwd: projectRoot,
      command: "bash",
      args: ["-lc", wrappedDashboardCommand],
    },
  };
}
