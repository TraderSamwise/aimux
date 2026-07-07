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
  "NO_COLOR",
]);

const ALLOWED_BASE_ENV_KEYS = new Set([
  "BUN_INSTALL",
  "CARGO_HOME",
  "CLICOLOR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COLORTERM",
  "CONDA_PREFIX",
  "GIT_CONFIG_GLOBAL",
  "GOBIN",
  "GOPATH",
  "HOME",
  "HOMEBREW_CELLAR",
  "HOMEBREW_PREFIX",
  "HOMEBREW_REPOSITORY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NVM_BIN",
  "NVM_DIR",
  "NVM_INC",
  "PATH",
  "PNPM_HOME",
  "PYENV_ROOT",
  "RUSTUP_HOME",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TERM",
  "TMPDIR",
  "USER",
  "VIRTUAL_ENV",
  "VOLTA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

const TRANSIENT_CONTROL_PATTERNS = [
  /(^|_)RECURSION(_|$)/i,
  /(^|_)WRAP(PER|PED|PING)?(_|$)/i,
  /(^|_)SHIM(MED|S)?(_|$)/i,
  /(^|_)BOOTSTRAP(_|$)/i,
  /(^|_)REEXEC(_|$)/i,
  /(^|_)INVOK(E|ATION)(_|$)/i,
];

const SENSITIVE_ENV_KEY_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|AUTH)/i;
const SAFE_SENSITIVE_NAMED_ENV_KEYS = new Set(["SSH_AUTH_SOCK"]);

function shouldExcludeEnvKey(key: string): boolean {
  if (EXCLUDED_ENV_KEYS.has(key)) return true;
  return TRANSIENT_CONTROL_PATTERNS.some((pattern) => pattern.test(key));
}

function shouldIncludeBaseEnvKey(key: string): boolean {
  if (shouldExcludeEnvKey(key)) return false;
  if (SENSITIVE_ENV_KEY_PATTERN.test(key) && !SAFE_SENSITIVE_NAMED_ENV_KEYS.has(key)) return false;
  return ALLOWED_BASE_ENV_KEYS.has(key) || key.startsWith("LC_");
}

function shouldIncludeExtraEnvKey(key: string): boolean {
  if (SENSITIVE_ENV_KEY_PATTERN.test(key) && !key.startsWith("AIMUX_") && !SAFE_SENSITIVE_NAMED_ENV_KEYS.has(key)) {
    return false;
  }
  return true;
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
    if (!shouldIncludeBaseEnvKey(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!shouldIncludeExtraEnvKey(key)) continue;
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
