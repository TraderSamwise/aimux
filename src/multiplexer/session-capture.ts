export function extractCodexBackendSessionIdFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "resume") {
      const next = args[i + 1]?.trim();
      if (next && !next.startsWith("-")) return next;
      continue;
    }
    if (arg === "--resume") {
      const next = args[i + 1]?.trim();
      if (next && !next.startsWith("-")) return next;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length).trim();
      if (value) return value;
    }
  }
  return undefined;
}
