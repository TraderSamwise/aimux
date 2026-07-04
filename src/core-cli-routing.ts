export function coreCommandArgs(argvOrRawArgs: string[]): string[] {
  const executable = argvOrRawArgs[0] ?? "";
  const isProcessArgv = /(?:^|[/\\])node(?:\.exe)?$/.test(executable) && argvOrRawArgs.length >= 2;
  const args = isProcessArgv ? argvOrRawArgs.slice(2) : argvOrRawArgs;
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "--debug" || arg === "--trace") && result.length === 0) continue;
    if ((arg === "--log-level" || arg === "--log-category") && result.length === 0) {
      index += 1;
      continue;
    }
    if ((arg.startsWith("--log-level=") || arg.startsWith("--log-category=")) && result.length === 0) continue;
    result.push(arg);
  }
  return result;
}

function hasHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function hasOnlyFlags(args: string[], allowed: Set<string>): boolean {
  return args.every((arg) => !arg.startsWith("-") || allowed.has(arg));
}

function hasNoOptions(args: string[]): boolean {
  return args.every((arg) => !arg.startsWith("-"));
}

function hasProjectOption(args: string[]): boolean {
  const index = args.indexOf("--project");
  if (index === -1) return false;
  const value = args[index + 1];
  return Boolean(value) && !value.startsWith("-");
}

export function isValidCoreProjectEnsureArgs(args: string[]): boolean {
  if (args[0] !== "daemon" || args[1] !== "project-ensure") return false;
  if (!hasProjectOption(args)) return false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      index += 1;
      continue;
    }
    if (arg === "--json") continue;
    return false;
  }
  return true;
}

export function isCoreCliCommand(args: string[]): boolean {
  if (hasHelp(args)) return false;
  const [command, subcommand] = args;
  if (command === "host" && subcommand === "status") return hasOnlyFlags(args.slice(2), new Set(["--json"]));
  if (command === "daemon" && ["ensure", "status", "projects"].includes(subcommand ?? "")) {
    return hasOnlyFlags(args.slice(2), new Set(["--json"]));
  }
  if (command === "daemon" && subcommand === "project-ensure") return true;
  if (command === "projects" && subcommand === "list") return hasOnlyFlags(args.slice(2), new Set(["--json"]));
  if (command === "remote" && subcommand === "status") return hasOnlyFlags(args.slice(2), new Set(["--json"]));
  if (command === "remote" && ["enable", "disable"].includes(subcommand ?? "")) return hasNoOptions(args.slice(2));
  return false;
}
