export function coreCommandArgs(argvOrRawArgs: string[]): string[] {
  const executable = argvOrRawArgs[0] ?? "";
  const isProcessArgv = /(?:^|[/\\])node(?:\.exe)?$/.test(executable) && argvOrRawArgs.length >= 2;
  const args = isProcessArgv ? argvOrRawArgs.slice(2) : argvOrRawArgs;
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--debug" || arg === "--trace") continue;
    if (arg === "--log-level" || arg === "--log-category") {
      const value = args[index + 1] ?? "";
      if (!value || value.startsWith("-")) {
        result.push(arg);
        continue;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--log-level=") || arg.startsWith("--log-category=")) {
      if (arg.endsWith("=")) result.push(arg);
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function hasCoreGlobalLoggingArgs(argvOrRawArgs: string[]): boolean {
  const executable = argvOrRawArgs[0] ?? "";
  const isProcessArgv = /(?:^|[/\\])node(?:\.exe)?$/.test(executable) && argvOrRawArgs.length >= 2;
  const args = isProcessArgv ? argvOrRawArgs.slice(2) : argvOrRawArgs;
  return args.some(
    (arg) =>
      arg === "--debug" ||
      arg === "--trace" ||
      arg === "--log-level" ||
      arg === "--log-category" ||
      arg.startsWith("--log-level=") ||
      arg.startsWith("--log-category="),
  );
}

function hasHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export interface CoreProjectEnsureArgs {
  project: string;
  json: boolean;
}

export interface CoreLogsArgs {
  daemon: boolean;
  lines?: string;
  project?: string;
  subcommand: "clear" | "path" | "tail";
}

function hasOnlyAllowedFlags(args: string[], allowed: Set<string>): boolean {
  return args.every((arg) => allowed.has(arg));
}

function hasRestartFlags(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--project") {
      const consumed = consumeRequiredValue(args, index);
      if (!consumed || consumed.value.startsWith("-")) return false;
      index = consumed.nextIndex;
      continue;
    }
    if (arg.startsWith("--project=")) {
      if (!arg.slice("--project=".length)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function consumeRequiredValue(args: string[], index: number): { nextIndex: number; value: string } | null {
  const value = args[index + 1];
  if (value === undefined || value === "") return null;
  return { nextIndex: index + 1, value };
}

export function parseCoreLogsArgs(args: string[]): CoreLogsArgs | null {
  if (args[0] !== "logs") return null;
  const subcommand = args[1] ?? "";
  if (!["path", "tail", "clear"].includes(subcommand)) return null;
  const parsed: CoreLogsArgs = { daemon: false, subcommand: subcommand as CoreLogsArgs["subcommand"] };
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--daemon") {
      parsed.daemon = true;
      continue;
    }
    if (arg === "--project") {
      const consumed = consumeRequiredValue(args, index);
      if (!consumed) return null;
      parsed.project = consumed.value;
      index = consumed.nextIndex;
      continue;
    }
    if (arg.startsWith("--project=")) {
      const value = arg.slice("--project=".length);
      if (!value) return null;
      parsed.project = value;
      continue;
    }
    if (subcommand === "tail" && (arg === "-n" || arg === "--lines")) {
      const consumed = consumeRequiredValue(args, index);
      if (!consumed) return null;
      parsed.lines = consumed.value;
      index = consumed.nextIndex;
      continue;
    }
    if (subcommand === "tail" && arg.startsWith("--lines=")) {
      const value = arg.slice("--lines=".length);
      if (!value) return null;
      parsed.lines = value;
      continue;
    }
    return null;
  }
  return parsed;
}

export function parseCoreProjectEnsureArgs(args: string[]): CoreProjectEnsureArgs | null {
  if (args[0] !== "daemon" || args[1] !== "project-ensure") return null;
  let project: string | null = null;
  let json = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--project") {
      const value = args[index + 1] ?? null;
      if (!value || value.startsWith("-")) return null;
      project = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      const value = arg.slice("--project=".length);
      if (!value) return null;
      project = value;
      continue;
    }
    return null;
  }
  return project ? { project, json } : null;
}

export function isValidCoreProjectEnsureArgs(args: string[]): boolean {
  return parseCoreProjectEnsureArgs(args) !== null;
}

export function isCoreProjectEnsureCommand(args: string[]): boolean {
  return args[0] === "daemon" && args[1] === "project-ensure";
}

export function isCoreCliCommand(args: string[]): boolean {
  if (hasHelp(args)) return false;
  const [command, subcommand] = args;
  if (command === "restart") return hasRestartFlags(args.slice(1));
  if (command === "serve") return args.length === 1;
  if (command === "host" && subcommand === "status") return hasOnlyAllowedFlags(args.slice(2), new Set(["--json"]));
  if (command === "host" && ["stop", "kill"].includes(subcommand ?? "")) return args.length === 2;
  if (command === "host" && subcommand === "restart") {
    return hasOnlyAllowedFlags(args.slice(2), new Set(["--serve"]));
  }
  if (command === "daemon" && ["ensure", "status", "projects"].includes(subcommand ?? "")) {
    return hasOnlyAllowedFlags(args.slice(2), new Set(["--json"]));
  }
  if (command === "daemon" && subcommand === "restart") return hasOnlyAllowedFlags(args.slice(2), new Set(["--json"]));
  if (command === "daemon" && subcommand === "project-ensure") return true;
  if (command === "logs") return parseCoreLogsArgs(args) !== null;
  if (command === "projects" && subcommand === "list") return hasOnlyAllowedFlags(args.slice(2), new Set(["--json"]));
  if (command === "remote" && subcommand === "status") return hasOnlyAllowedFlags(args.slice(2), new Set(["--json"]));
  if (command === "remote" && ["enable", "disable"].includes(subcommand ?? "")) return args.length === 2;
  if (command === "whoami") return hasOnlyAllowedFlags(args.slice(1), new Set(["--json"]));
  if (command === "logout") return args.length === 1;
  if (command === "login") return args.length === 1;
  if (command === "security" && subcommand === "unlock") return args.length === 2;
  return false;
}
