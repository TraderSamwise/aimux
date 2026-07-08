const ALLOWED_ENV_KEYS = new Set([
  "AIMUX_DAEMON_PORT",
  "AIMUX_ENV",
  "AIMUX_HOME",
  "BUN_INSTALL",
  "CARGO_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLICOLOR",
  "CODEX_HOME",
  "CODEX_MANAGED_PACKAGE_ROOT",
  "COLORTERM",
  "CONDA_DEFAULT_ENV",
  "CONDA_EXE",
  "CONDA_PREFIX",
  "CONDA_PROMPT_MODIFIER",
  "CONDA_SHLVL",
  "EDITOR",
  "GEM_HOME",
  "GEM_PATH",
  "GHOSTTY_RESOURCES_DIR",
  "GOPATH",
  "GOROOT",
  "GPG_TTY",
  "HOME",
  "JAVA_HOME",
  "LANG",
  "LOGNAME",
  "MANPATH",
  "NVM_BIN",
  "NVM_DIR",
  "NVM_INC",
  "PAGER",
  "PATH",
  "PNPM_HOME",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "RUSTUP_HOME",
  "SHELL",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMPDIR",
  "USER",
  "VISUAL",
  "VOLTA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "ZSH",
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
  if (key.startsWith("LC_")) return false;
  if (!ALLOWED_ENV_KEYS.has(key)) return true;
  return TRANSIENT_CONTROL_PATTERNS.some((pattern) => pattern.test(key));
}

function normalizeInteractiveColorEnv(env: Record<string, string>): void {
  delete env.NO_COLOR;
  if (!env.TERM || env.TERM === "dumb") {
    env.TERM = "xterm-256color";
  }
  if (!env.COLORTERM) {
    env.COLORTERM = "truecolor";
  }
  if (!env.CLICOLOR) {
    env.CLICOLOR = "1";
  }
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
  normalizeInteractiveColorEnv(env);
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
