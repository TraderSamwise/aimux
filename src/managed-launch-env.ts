const EXCLUDED_ENV_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "TMUX_CLIENT",
  "TMUX_TMPDIR",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "ZDOTDIR",
  "AIMUX_SESSION_ID",
  "AIMUX_TOOL",
  "AIMUX_METADATA_ENDPOINT_FILE",
  "AIMUX_SHELL_INTEGRATION_SCRIPT",
]);

const TRANSIENT_CONTROL_PATTERNS = [
  /(^|_)RECURSION(_|$)/i,
  /(^|_)WRAP(PER|PED|PING)?(_|$)/i,
  /(^|_)SHIM(MED|S)?(_|$)/i,
  /(^|_)BOOTSTRAP(_|$)/i,
  /(^|_)REEXEC(_|$)/i,
  /(^|_)INVOK(E|ATION)(_|$)/i,
];

function shouldExcludeEnvKey(key: string): boolean {
  if (EXCLUDED_ENV_KEYS.has(key)) return true;
  return TRANSIENT_CONTROL_PATTERNS.some((pattern) => pattern.test(key));
}

export function buildManagedLaunchEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string" || !value) continue;
    if (shouldExcludeEnvKey(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = value;
  }
  return env;
}

export function wrapCommandWithManagedLaunchEnv(opts: {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
}): { command: string; args: string[] } {
  const managedEnv = buildManagedLaunchEnv(opts.env, opts.extraEnv);
  const envArgs = ["-i", ...Object.entries(managedEnv).map(([key, value]) => `${key}=${value}`)];
  return {
    command: "env",
    args: [...envArgs, opts.command, ...opts.args],
  };
}
