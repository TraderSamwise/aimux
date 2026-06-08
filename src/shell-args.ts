export interface LaunchOverride {
  /** Binary to exec. May differ from the tool's configured command. */
  command: string;
  /** Full argument list (replaces the tool's default args, not appended). */
  args: string[];
  /** Extra env vars merged into the managed launch environment. */
  env?: Record<string, string>;
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Parse a whitespace-separated list of NAME=VALUE environment assignments.
 * Throws if any token is not a valid assignment.
 */
export function parseEnvAssignments(input: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const token of parseShellArgs(input)) {
    const match = ENV_ASSIGNMENT.exec(token);
    if (!match) {
      throw new Error(`invalid env var "${token}" (expected NAME=VALUE)`);
    }
    env[match[1]] = match[2];
  }
  return env;
}

export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaping) {
      current += ch;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
        tokenStarted = true;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error(`unterminated ${quote === "'" ? "single" : "double"} quote`);
  }
  if (tokenStarted) {
    args.push(current);
  }

  return args;
}
